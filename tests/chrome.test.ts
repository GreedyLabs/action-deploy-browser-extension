import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ChromeWebStoreTarget } from '../src/targets/chrome.js';
import { HttpClient } from '../src/http.js';
import { type ActionInputs, type DeployContext, type Receipt, type StepRecord } from '../src/types.js';

vi.mock('../src/google-auth.js', () => ({ createGoogleAccessToken: vi.fn(async () => 'test-token') }));
const itemId = 'publishers/publisher/items/extension';
const identity = { name: itemId, itemId: 'extension' };
const artifactPath = new URL('./fixtures/dist.zip', import.meta.url).pathname;
const artifact = { path: artifactPath, version: '1.2.3', sha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex') };
const options: ActionInputs = {
  zipPath: artifact.path, targets: ['chrome'], operation: 'deploy', chromeExtensionId: 'extension', chromePublisherId: 'publisher',
  edgeProductId: '', stateDir: '/unused', requestTimeoutMs: 1000, pollTimeoutMs: 50, pollIntervalMs: 1, maxAttempts: 1,
};
function status(state?: string, version = artifact.version, published = false) {
  return { ...identity, ...(state ? { [published ? 'publishedItemRevisionStatus' : 'submittedItemRevisionStatus']: { state, distributionChannels: [{ crxVersion: version }] } } : {}) };
}
function context(operation: ActionInputs['operation'] = 'deploy', upload?: StepRecord, publish?: StepRecord): DeployContext {
  const receipt: Receipt | undefined = upload || publish ? { schemaVersion: 1, target: 'chrome', itemId, version: artifact.version, sha256: artifact.sha256, upload, publish } : undefined;
  const ctx: DeployContext = {
    options: { ...options, operation }, artifact: operation === 'status' ? undefined : artifact, receipt,
    result: { target: 'chrome', name: 'Chrome Web Store', operation, phase: 'validate', outcome: 'success' },
    http: new HttpClient(options), log: vi.fn(),
    record: vi.fn(async (phase: 'upload' | 'publish', step: StepRecord) => {
      ctx.receipt ??= { schemaVersion: 1, target: 'chrome', itemId, version: artifact.version, sha256: artifact.sha256 };
      ctx.receipt[phase] = step;
      ctx.result[phase] = step.state;
    }),
  };
  return ctx;
}
function responses(...values: Array<unknown | Error>) {
  const mock = vi.fn(async () => {
    if (!values.length) throw new Error('Unexpected request');
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
function target() { return new ChromeWebStoreTarget('extension', 'publisher'); }
function writes(mock: ReturnType<typeof responses>) { return mock.mock.calls.filter((call) => (call as unknown as [string, RequestInit])[1]?.method === 'POST'); }

beforeEach(() => vi.stubEnv('CHROME_SERVICE_ACCOUNT_KEY', '{}'));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('Chrome V2 deployment and resumption', () => {
  it('requires the publisher ID rather than sending V1 requests', () => {
    expect(() => new ChromeWebStoreTarget('extension', '').validate()).toThrow('chrome-publisher-id');
  });

  it('reads status without a ZIP or a store write', async () => {
    const mock = responses(status('PENDING_REVIEW'));
    const ctx = context('status');
    await target().execute(ctx);
    expect(ctx.result).toMatchObject({ outcome: 'success', remoteState: 'PENDING_REVIEW', version: artifact.version });
    expect(mock).toHaveBeenCalledWith(`https://chromewebstore.googleapis.com/v2/${itemId}:fetchStatus`, expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }));
    expect(writes(mock)).toHaveLength(0);
  });

  it.each(['PENDING_REVIEW', 'STAGED'])('preserves an already submitted identical version in state %s', async (state) => {
    const mock = responses(status(state));
    const ctx = context();
    await target().execute(ctx);
    expect(ctx.result.outcome).toBe('skipped');
    expect(ctx.receipt?.publish?.state).toBe('succeeded');
    expect(writes(mock)).toHaveLength(0);
  });

  it.each(['PUBLISHED', 'PUBLISHED_TO_TESTERS'])('skips an identical version already %s', async (state) => {
    const mock = responses(status(state, artifact.version, true));
    const ctx = context();
    await target().execute(ctx);
    expect(ctx.result).toMatchObject({ outcome: 'skipped', remoteState: state });
    expect(writes(mock)).toHaveLength(0);
  });

  it('blocks a different pending version without cancelling or replacing it', async () => {
    const mock = responses(status('PENDING_REVIEW', '2.0.0'));
    await expect(target().execute(context())).rejects.toMatchObject({ code: 'CHROME_SUBMISSION_CONFLICT', outcome: 'blocked' });
    expect(writes(mock)).toHaveLength(0);
  });

  it('does not treat an unidentified pending version as the requested ZIP', async () => {
    const mock = responses({ ...identity, submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } });
    await expect(target().execute(context())).rejects.toMatchObject({ code: 'CHROME_SUBMISSION_CONFLICT' });
    expect(writes(mock)).toHaveLength(0);
  });

  it('blocks taken-down items and unrecognized or mismatched status responses', async () => {
    for (const remote of [{ ...status(), takenDown: true }, status('NEW_STATE'), {}, { ...identity, itemId: 'different' }]) {
      const mock = responses(remote);
      await expect(target().execute(context())).rejects.toMatchObject({ outcome: 'blocked' });
      expect(writes(mock)).toHaveLength(0);
    }
  });

  it('uploads a new package then submits for review and does not call that live publication', async () => {
    const mock = responses(status(), { ...identity, uploadState: 'SUCCEEDED', crxVersion: artifact.version }, status(), { ...identity, state: 'PENDING_REVIEW' });
    const ctx = context();
    await target().execute(ctx);
    expect(ctx.result).toMatchObject({ phase: 'publish', outcome: 'success', remoteState: 'PENDING_REVIEW' });
    expect(ctx.result.message).toContain('not yet live');
    expect(writes(mock)).toHaveLength(2);
    expect(mock).toHaveBeenNthCalledWith(2, `https://chromewebstore.googleapis.com/upload/v2/${itemId}:upload`, expect.objectContaining({ method: 'POST', body: expect.any(Uint8Array) }));
    expect(ctx.record).toHaveBeenNthCalledWith(1, 'upload', expect.objectContaining({ state: 'uncertain' }));
    expect(ctx.record).toHaveBeenNthCalledWith(3, 'publish', expect.objectContaining({ state: 'uncertain' }));
  });

  it('rejects changed ZIP bytes before recording an intent or sending the package', async () => {
    const mock = responses(status());
    const ctx = context('upload');
    ctx.artifact = { ...artifact, sha256: '0'.repeat(64) };
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'PACKAGE_CHANGED', outcome: 'blocked' });
    expect(ctx.record).not.toHaveBeenCalled();
    expect(writes(mock)).toHaveLength(0);
  });

  it('waits for an acknowledged async upload instead of failing or submitting early', async () => {
    const mock = responses(status(), { ...identity, uploadState: 'IN_PROGRESS' }, { ...status(), lastAsyncUploadState: 'IN_PROGRESS' }, { ...status(), lastAsyncUploadState: 'SUCCEEDED' });
    const ctx = context('upload');
    await target().execute(ctx);
    expect(ctx.receipt?.upload?.state).toBe('succeeded');
    expect(ctx.record).toHaveBeenCalledWith('upload', expect.objectContaining({ state: 'pending' }));
    expect(writes(mock)).toHaveLength(1);
  });

  it('resumes an acknowledged async upload without uploading again', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'IN_PROGRESS' }, { ...status(), lastAsyncUploadState: 'SUCCEEDED' });
    const ctx = context('upload', { state: 'pending' });
    await target().execute(ctx);
    expect(ctx.receipt?.upload?.state).toBe('succeeded');
    expect(writes(mock)).toHaveLength(0);
  });

  it('confirms an acknowledged upload during status-only so publish-only can resume', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'SUCCEEDED' }, status(), { ...identity, state: 'PENDING_REVIEW' });
    const ctx = context('status', { state: 'pending' });
    await target().execute(ctx);
    expect(ctx.receipt?.upload?.state).toBe('succeeded');
    expect(ctx.result.outcome).toBe('success');
    expect(writes(mock)).toHaveLength(0);
    ctx.options.operation = 'publish';
    ctx.artifact = artifact;
    await target().execute(ctx);
    expect(ctx.receipt?.publish?.state).toBe('succeeded');
    expect(writes(mock)).toHaveLength(1);
  });

  it('reports an acknowledged upload still processing as pending after one status read', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'IN_PROGRESS' });
    const ctx = context('status', { state: 'pending' });
    await target().execute(ctx);
    expect(ctx.receipt?.upload?.state).toBe('pending');
    expect(ctx.result.outcome).toBe('pending');
    expect(mock).toHaveBeenCalledOnce();
    expect(writes(mock)).toHaveLength(0);
  });

  it('records acknowledged upload failure during status-only', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'FAILED' });
    const ctx = context('status', { state: 'pending' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_FAILED' });
    expect(ctx.receipt?.upload?.state).toBe('failed');
    expect(writes(mock)).toHaveLength(0);
  });

  it.each([undefined, 'NOT_FOUND'])('blocks acknowledged uploads with missing or expired status %s', async (lastAsyncUploadState) => {
    const mock = responses({ ...status(), lastAsyncUploadState });
    const ctx = context('status', { state: 'pending' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_UNCONFIRMED', outcome: 'blocked' });
    expect(ctx.receipt?.upload?.state).toBe('pending');
    expect(writes(mock)).toHaveLength(0);
  });

  it('does not confirm an uncertain upload merely from successful asynchronous status', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'SUCCEEDED' });
    const ctx = context('status', { state: 'uncertain' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_UNCONFIRMED', outcome: 'blocked' });
    expect(ctx.receipt?.upload?.state).toBe('uncertain');
    expect(writes(mock)).toHaveLength(0);
  });

  it('records async package validation failure and stops before publishing', async () => {
    const mock = responses(status(), { ...identity, uploadState: 'IN_PROGRESS' }, { ...status(), lastAsyncUploadState: 'FAILED' });
    const ctx = context();
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_FAILED' });
    expect(ctx.receipt?.upload?.state).toBe('failed');
    expect(writes(mock)).toHaveLength(1);
  });

  it('blocks an expired async status instead of replaying the upload', async () => {
    const mock = responses(status(), { ...status(), lastAsyncUploadState: 'NOT_FOUND' });
    const ctx = context('upload', { state: 'pending' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_UNCONFIRMED' });
    expect(ctx.receipt?.upload?.state).toBe('pending');
    expect(writes(mock)).toHaveLength(0);
  });

  it('does not infer ZIP identity from the last async upload after a lost response', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'SUCCEEDED' });
    const ctx = context('upload', { state: 'uncertain' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_UNCONFIRMED' });
    expect(writes(mock)).toHaveLength(0);
  });

  it('refuses to start an upload while an unidentified async upload is in progress', async () => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'IN_PROGRESS' });
    await expect(target().execute(context('upload'))).rejects.toMatchObject({ code: 'CHROME_UPLOAD_CONFLICT' });
    expect(writes(mock)).toHaveLength(0);
  });

  it('reuses a successful matching upload receipt without another store write', async () => {
    const mock = responses(status());
    const ctx = context('upload', { state: 'succeeded' });
    await target().execute(ctx);
    expect(ctx.result.outcome).toBe('skipped');
    expect(writes(mock)).toHaveLength(0);
  });

  it.each(['publish', 'deploy'] as const)('blocks %s with a successful receipt when a different upload is now processing', async (operation) => {
    const mock = responses({ ...status(), lastAsyncUploadState: 'IN_PROGRESS' });
    const ctx = context(operation, { state: 'succeeded' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_CONFLICT', outcome: 'blocked' });
    expect(ctx.receipt?.upload?.state).toBe('succeeded');
    expect(ctx.receipt?.publish).toBeUndefined();
    expect(writes(mock)).toHaveLength(0);
  });

  it('checks for a newly observed external upload immediately before publication', async () => {
    const mock = responses(status(), { ...identity, uploadState: 'SUCCEEDED', crxVersion: artifact.version }, { ...status(), lastAsyncUploadState: 'IN_PROGRESS' });
    const ctx = context();
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_UPLOAD_CONFLICT', outcome: 'blocked' });
    expect(ctx.receipt?.upload?.state).toBe('succeeded');
    expect(ctx.receipt?.publish).toBeUndefined();
    expect(writes(mock)).toHaveLength(1);
    expect(mock).not.toHaveBeenCalledWith(`https://chromewebstore.googleapis.com/v2/${itemId}:publish`, expect.anything());
  });

  it('requires an upload receipt for publish-only operations', async () => {
    const mock = responses(status());
    await expect(target().execute(context('publish'))).rejects.toMatchObject({ code: 'CHROME_UPLOAD_RECEIPT_REQUIRED' });
    expect(writes(mock)).toHaveLength(0);
  });

  it('publishes a recorded package without re-uploading it', async () => {
    const mock = responses(status(), { ...identity, state: 'PENDING_REVIEW' });
    const ctx = context('publish', { state: 'succeeded' });
    await target().execute(ctx);
    expect(ctx.receipt?.publish?.state).toBe('succeeded');
    expect(writes(mock)).toHaveLength(1);
    expect(mock).toHaveBeenLastCalledWith(`https://chromewebstore.googleapis.com/v2/${itemId}:publish`, expect.objectContaining({ body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }) }));
  });

  it('reconciles a lost submission response by matching the submitted version', async () => {
    const mock = responses(status(), new Error('lost response'), status('PENDING_REVIEW'));
    const ctx = context('publish', { state: 'succeeded' });
    await target().execute(ctx);
    expect(ctx.receipt?.publish?.state).toBe('succeeded');
    expect(ctx.result.outcome).toBe('skipped');
    expect(writes(mock)).toHaveLength(1);
  });

  it('blocks a previous uncertain submission when its version is not remotely confirmed', async () => {
    const mock = responses(status());
    await expect(target().execute(context('publish', { state: 'succeeded' }, { state: 'uncertain' }))).rejects.toMatchObject({ code: 'CHROME_PUBLISH_UNCONFIRMED' });
    expect(writes(mock)).toHaveLength(0);
  });

  it('does not replay a write after a 503 or use an unrelated async success as proof', async () => {
    const mock = responses(status(), new Response('temporary failure', { status: 503 }), { ...status(), lastAsyncUploadState: 'SUCCEEDED' });
    const ctx = context('upload');
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_WRITE_UNCONFIRMED' });
    expect(ctx.receipt?.upload?.state).toBe('uncertain');
    expect(writes(mock)).toHaveLength(1);
  });

  it('records definitive HTTP rejection without claiming publication success', async () => {
    const mock = responses(status(), new Response('permission denied', { status: 403 }));
    const ctx = context('publish', { state: 'succeeded' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'HTTP_403' });
    expect(ctx.receipt?.publish?.state).toBe('failed');
    expect(writes(mock)).toHaveLength(1);
  });

  it.each(['REJECTED', 'CANCELLED'])('fails a submission response with state %s', async (state) => {
    const mock = responses(status(), { ...identity, state });
    const ctx = context('publish', { state: 'succeeded' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_SUBMISSION_FAILED' });
    expect(ctx.receipt?.publish?.state).toBe('failed');
    expect(writes(mock)).toHaveLength(1);
  });

  it('blocks unknown submission states even on HTTP success', async () => {
    const mock = responses(status(), { ...identity, state: 'NOT_AUTHORIZED' }, status());
    const ctx = context('publish', { state: 'succeeded' });
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_WRITE_UNCONFIRMED' });
    expect(ctx.receipt?.publish?.state).toBe('uncertain');
    expect(writes(mock)).toHaveLength(1);
  });

  it('does not submit a synchronous upload whose confirmed version differs from the ZIP', async () => {
    const mock = responses(status(), { ...identity, uploadState: 'SUCCEEDED', crxVersion: '9.9.9' }, status());
    const ctx = context();
    await expect(target().execute(ctx)).rejects.toMatchObject({ code: 'CHROME_WRITE_UNCONFIRMED' });
    expect(ctx.receipt?.upload?.state).toBe('uncertain');
    expect(writes(mock)).toHaveLength(1);
  });
});
