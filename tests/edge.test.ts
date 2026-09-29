import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EdgeAddonsTarget } from '../src/targets/edge.js';
import { HttpClient } from '../src/http.js';
import type { ActionInputs, DeployContext, Receipt, StepRecord } from '../src/types.js';

const PRODUCT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UPLOAD = '11111111-2222-3333-4444-555555555555';
const PUBLISH = '66666666-7777-8888-9999-000000000000';
const BASE = `https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions`;
const ARTIFACT = { path: 'tests/fixtures/dist.zip', version: '1.2.3', sha256: createHash('sha256').update(readFileSync('tests/fixtures/dist.zip')).digest('hex') };

function receipt(upload?: StepRecord, publish?: StepRecord): Receipt {
  return { schemaVersion: 1, target: 'edge', itemId: PRODUCT, version: ARTIFACT.version, sha256: ARTIFACT.sha256, upload, publish };
}

function context(operation: ActionInputs['operation'], saved?: Receipt): DeployContext {
  const options: ActionInputs = {
    operation, zipPath: ARTIFACT.path, targets: ['edge'], chromeExtensionId: '', chromePublisherId: '',
    edgeProductId: PRODUCT, stateDir: '/unused', requestTimeoutMs: 100, pollTimeoutMs: 100,
    pollIntervalMs: 1, maxAttempts: 2,
  };
  const ctx: DeployContext = {
    options, artifact: operation === 'status' ? undefined : ARTIFACT, receipt: saved,
    result: { target: 'edge', name: 'Microsoft Edge Add-ons', operation, outcome: 'success', phase: 'validate' },
    http: new HttpClient(options), log: vi.fn(),
    record: vi.fn(async (phase: 'upload' | 'publish', step: StepRecord) => {
      ctx.receipt ??= receipt();
      ctx.receipt[phase] = step;
      ctx.result[phase] = step.state;
      if (phase === 'upload') ctx.result.uploadOperationId = step.operationId;
      else ctx.result.publishOperationId = step.operationId;
    }),
  };
  return ctx;
}

function accepted(id: string): Response {
  return new Response(null, { status: 202, headers: { Location: id } });
}
function state(status: string, id: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ id, status, ...extra }), { status: 200 });
}
function calls(mock: ReturnType<typeof vi.fn<typeof fetch>>): Array<[string, string]> {
  return mock.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET']);
}

beforeEach(() => {
  vi.stubEnv('EDGE_CLIENT_ID', 'test-client');
  vi.stubEnv('EDGE_API_KEY', 'test-key');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Edge deployment operations', () => {
  it('waits for upload processing before creating and confirming a submission', async () => {
    const ctx = context('deploy');
    const responses = [accepted(UPLOAD), state('InProgress', UPLOAD), state('Succeeded', UPLOAD), accepted(PUBLISH), state('Succeeded', PUBLISH)];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        const phase = String(_url).endsWith('/package') ? 'upload' : 'publish';
        expect(ctx.receipt?.[phase]?.state).toBe('uncertain');
        if (phase === 'publish') expect(ctx.receipt?.upload?.state).toBe('succeeded');
      }
      return responses.shift()!;
    });
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)).toEqual([
      [`${BASE}/draft/package`, 'POST'], [`${BASE}/draft/package/operations/${UPLOAD}`, 'GET'],
      [`${BASE}/draft/package/operations/${UPLOAD}`, 'GET'], [BASE, 'POST'], [`${BASE}/operations/${PUBLISH}`, 'GET'],
    ]);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ Authorization: 'ApiKey test-key', 'X-ClientID': 'test-client', 'Content-Type': 'application/zip' });
    expect(init.redirect).toBe('error');
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(ctx.receipt?.upload).toMatchObject({ state: 'succeeded', operationId: UPLOAD });
    expect(ctx.receipt?.publish).toMatchObject({ state: 'succeeded', operationId: PUBLISH });
    expect(ctx.result).toMatchObject({ phase: 'publish', outcome: 'success', remoteState: 'submission-created' });
    expect(ctx.result.message).toContain('does not confirm that the extension is live');
  });

  it('blocks a ZIP changed after artifact validation before recording or sending a write', async () => {
    const ctx = context('upload');
    ctx.artifact = { ...ARTIFACT, sha256: '0'.repeat(64) };
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'PACKAGE_CHANGED', outcome: 'blocked' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.record).not.toHaveBeenCalled();
  });

  it('upload-only confirms processing without creating a submission', async () => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted(UPLOAD)).mockResolvedValueOnce(state('Succeeded', UPLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)).toEqual([[`${BASE}/draft/package`, 'POST'], [`${BASE}/draft/package/operations/${UPLOAD}`, 'GET']]);
    expect(ctx.receipt?.publish).toBeUndefined();
    expect(ctx.result.remoteState).toBe('uploaded');
  });

  it('resumes an accepted upload using only its saved operation', async () => {
    const ctx = context('upload', receipt({ state: 'pending', operationId: UPLOAD }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(state('Succeeded', UPLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)).toEqual([[`${BASE}/draft/package/operations/${UPLOAD}`, 'GET']]);
    expect(ctx.receipt?.upload?.state).toBe('succeeded');
  });

  it('resumes an accepted publication without another upload or publish POST', async () => {
    const ctx = context('deploy', receipt({ state: 'succeeded', operationId: UPLOAD }, { state: 'pending', operationId: PUBLISH }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(state('Succeeded', PUBLISH));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)).toEqual([[`${BASE}/operations/${PUBLISH}`, 'GET']]);
    expect(ctx.receipt?.publish?.state).toBe('succeeded');
  });

  it('skips a matching ZIP with successful upload and publish receipts', async () => {
    const ctx = context('deploy', receipt({ state: 'succeeded', operationId: UPLOAD }, { state: 'succeeded', operationId: PUBLISH }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.result.outcome).toBe('skipped');
  });

  it.each(['pending', 'uncertain'] as const)('never repeats an upload with %s state and no operation ID', async (savedState) => {
    const ctx = context('upload', receipt({ state: savedState }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_OPERATION_UNCERTAIN', outcome: 'blocked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never repeats a publication with uncertain acceptance and no operation ID', async () => {
    const ctx = context('publish', receipt({ state: 'succeeded', operationId: UPLOAD }, { state: 'uncertain' }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_OPERATION_UNCERTAIN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, receipt({ state: 'pending', operationId: UPLOAD }), receipt({ state: 'failed' })])('requires a confirmed upload receipt for publish-only', async (saved) => {
    const ctx = context('publish', saved);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'UPLOAD_NOT_CONFIRMED', outcome: 'blocked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes an already confirmed matching upload', async () => {
    const ctx = context('publish', receipt({ state: 'succeeded', operationId: UPLOAD }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted(PUBLISH)).mockResolvedValueOnce(state('Succeeded', PUBLISH));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)).toEqual([[BASE, 'POST'], [`${BASE}/operations/${PUBLISH}`, 'GET']]);
  });

  it.each(['version', 'sha256', 'itemId'] as const)('blocks a receipt with a different %s', async (key) => {
    const saved = receipt({ state: 'succeeded', operationId: UPLOAD });
    saved[key] = 'different';
    const ctx = context('publish', saved);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'PACKAGE_CONFLICT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Edge operation results and authentication', () => {
  it.each(['InProgressSubmission', 'ModuleStateUnPublishable', 'UnpublishInProgress'])('reports semantic HTTP 200 failure %s as blocked', async (errorCode) => {
    const ctx = context('publish', receipt({ state: 'succeeded', operationId: UPLOAD }, { state: 'pending', operationId: PUBLISH }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(state('Failed', PUBLISH, { errorCode, message: 'Cannot submit', errors: ['details'] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: `EDGE_${errorCode}`, outcome: 'blocked' });
    expect(ctx.receipt?.publish).toMatchObject({ state: 'failed', operationId: PUBLISH });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not publish after a failed upload operation returned in an HTTP 200 body', async () => {
    const ctx = context('deploy');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted(UPLOAD)).mockResolvedValueOnce(state('Failed', UPLOAD, { errorCode: 'InvalidPackage', message: 'Bad manifest' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_InvalidPackage', outcome: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.receipt?.upload?.state).toBe('failed');
    expect(ctx.receipt?.publish).toBeUndefined();
  });

  it.each([401, 403])('reports authentication failure %s without retrying or retaining a false pending write', async (status) => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Unauthorized', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_AUTH_FAILED', outcome: 'failed', message: expect.stringContaining('EDGE_CLIENT_ID, EDGE_API_KEY') });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.receipt?.upload?.state).toBe('failed');
  });

  it('retains a saved operation when a status GET encounters an auth error', async () => {
    const ctx = context('status', receipt({ state: 'pending', operationId: UPLOAD }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_AUTH_FAILED' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.receipt?.upload).toEqual({ state: 'pending', operationId: UPLOAD });
  });

  it('does not retry a POST after a server error and blocks a later automatic resend', async () => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const target = new EdgeAddonsTarget(PRODUCT);
    await expect(target.execute(ctx)).rejects.toMatchObject({ code: 'HTTP_503', outcome: 'pending' });
    expect(ctx.receipt?.upload?.state).toBe('uncertain');
    await expect(target.execute(ctx)).rejects.toMatchObject({ code: 'EDGE_OPERATION_UNCERTAIN' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retains uncertain intent when the upload connection fails', async () => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('connection lost'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'REQUEST_UNCERTAIN', outcome: 'pending' });
    expect(ctx.receipt?.upload?.state).toBe('uncertain');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the operation ID on polling timeout', async () => {
    const ctx = context('upload', receipt({ state: 'pending', operationId: UPLOAD }));
    ctx.options.pollTimeoutMs = 3;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => state('InProgress', UPLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'POLL_TIMEOUT', outcome: 'pending' });
    expect(ctx.receipt?.upload).toMatchObject({ state: 'pending', operationId: UPLOAD });
    expect(calls(fetchMock).every(([, method]) => method === 'GET')).toBe(true);
  });

  it.each([{}, { status: 'Unknown' }, { status: 'Succeeded', id: PUBLISH }])('does not accept malformed or mismatched operation JSON', async (data) => {
    const ctx = context('upload', receipt({ state: 'pending', operationId: UPLOAD }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_INVALID_STATUS', outcome: 'pending' });
    expect(ctx.receipt?.upload?.state).toBe('pending');
  });
});

describe('Edge operation location validation', () => {
  it.each([UPLOAD, `${BASE}/draft/package/operations/${UPLOAD}`, `/v1/products/${PRODUCT}/submissions/draft/package/operations/${UPLOAD}`])('accepts an operation GUID or the matching API location', async (location) => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted(location)).mockResolvedValueOnce(state('Succeeded', UPLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)[1]).toEqual([`${BASE}/draft/package/operations/${UPLOAD}`, 'GET']);
    expect(ctx.receipt?.upload?.operationId).toBe(UPLOAD);
  });

  it.each([
    '', 'not-a-guid', `https://example.com/operations/${UPLOAD}`, `//example.com/operations/${UPLOAD}`,
    `https://user:pass@api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions/draft/package/operations/${UPLOAD}`,
    `${BASE}/operations/${UPLOAD}`, `${BASE}/draft/package/operations/${UPLOAD}?other=1`,
    `${BASE}/draft/package/operations/${UPLOAD}#fragment`, `${BASE}/draft/package/operations/${UPLOAD}/more`,
    `${BASE.replace(PRODUCT, PUBLISH)}/draft/package/operations/${UPLOAD}`,
  ])('never sends credentials to an invalid returned location', async (location) => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted(location));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_INVALID_OPERATION_ID', outcome: 'pending' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.receipt?.upload).toMatchObject({ state: 'uncertain' });
    expect(ctx.receipt?.upload?.operationId).toBeUndefined();
  });

  it('rejects a non-202 upload acknowledgment without claiming success', async () => {
    const ctx = context('upload');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_INVALID_RESPONSE', outcome: 'pending' });
    expect(ctx.receipt?.upload?.state).toBe('uncertain');
  });

  it('rejects a malicious saved operation ID before any request', async () => {
    const ctx = context('status', receipt({ state: 'pending', operationId: 'https://example.com/stolen' }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new EdgeAddonsTarget(PRODUCT).execute(ctx)).rejects.toMatchObject({ code: 'EDGE_INVALID_OPERATION_ID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Edge status-only reads', () => {
  it.each([undefined, receipt()])('reports unknown without pretending that the API can discover global state', async (saved) => {
    const ctx = context('status', saved);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.result).toMatchObject({ outcome: 'skipped', remoteState: 'unknown', phase: 'status' });
    expect(ctx.result.message).toContain('without a saved operation ID');
  });

  it('checks a pending operation once without polling or writing remotely', async () => {
    const ctx = context('status', receipt({ state: 'pending', operationId: UPLOAD }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(state('InProgress', UPLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock)).toEqual([[`${BASE}/draft/package/operations/${UPLOAD}`, 'GET']]);
    expect(ctx.result).toMatchObject({ outcome: 'pending', remoteState: 'upload-in-progress' });
  });

  it('checks saved successful upload and publication operations without a ZIP', async () => {
    const ctx = context('status', receipt({ state: 'succeeded', operationId: UPLOAD }, { state: 'pending', operationId: PUBLISH }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(state('Succeeded', UPLOAD)).mockResolvedValueOnce(state('Succeeded', PUBLISH));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(calls(fetchMock).every(([, method]) => method === 'GET')).toBe(true);
    expect(ctx.result).toMatchObject({ outcome: 'success', remoteState: 'submission-created' });
    expect(ctx.receipt?.publish?.state).toBe('succeeded');
  });

  it('reports uncertain intent with no operation as unknown and never submits', async () => {
    const ctx = context('status', receipt({ state: 'uncertain' }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.result).toMatchObject({ outcome: 'pending', remoteState: 'unknown' });
    expect(ctx.result.message).toContain('reconcile the receipt');
  });

  it('retries a throttled GET using the shared client, without a write', async () => {
    const ctx = context('status', receipt({ state: 'pending', operationId: UPLOAD }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(state('Succeeded', UPLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await new EdgeAddonsTarget(PRODUCT).execute(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls(fetchMock).every(([, method]) => method === 'GET')).toBe(true);
  });

  it('validates the Partner Center product ID format', () => {
    expect(() => new EdgeAddonsTarget('https://example.com').validate()).toThrow('product GUID');
    expect(() => new EdgeAddonsTarget(PRODUCT).validate()).not.toThrow();
  });
});
