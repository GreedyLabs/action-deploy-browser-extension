import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryApi } from '../src/control/github.js';
const context = { owner: 'owner', repo: 'extension', sha: 'a'.repeat(40), runId: 100, runAttempt: 1 };
const client = new RepositoryApi('test-token', context);
afterEach(() => vi.unstubAllGlobals());

describe('reusable workflow GitHub access', () => {
  it('paginates complete job history instead of missing an older target job', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ name: `job-${i}`, status: 'completed', conclusion: 'success' }));
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 101, jobs: first })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 101, jobs: [{ name: 'target', status: 'completed', conclusion: 'failure' }] })));
    vi.stubGlobal('fetch', fetch);
    const jobs = await client.listJobs(100, 2);
    expect(jobs).toHaveLength(101);
    expect(fetch.mock.calls[1]![0]).toContain('/attempts/2/jobs?per_page=100&page=2');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-token' } });
  });
  it('scopes automatic source selection to a workflow, commit, and branch', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workflow_runs: [] })));
    vi.stubGlobal('fetch', fetch);
    await client.listRuns(5, context.sha, 'release/stable');
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/repos/owner/extension/actions/workflows/5/runs');
    expect(url.searchParams.get('head_sha')).toBe(context.sha);
    expect(url.searchParams.get('branch')).toBe('release/stable');
    expect(url.searchParams.get('event')).toBe('push');
  });
  it('fails closed when GitHub would truncate the searched history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ total_count: 1001, workflow_runs: [] }))));
    await expect(client.listRuns(5, context.sha)).rejects.toThrow('too large');
  });
  it('does not interpret malformed history as an empty first run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    await expect(client.listArtifacts(100)).rejects.toThrow('invalid artifacts');
  });
  it('checks requested run identity before using its package', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 101, workflow_id: 5, run_attempt: 1, head_sha: context.sha, status: 'completed' }))));
    await expect(client.getRun(100)).rejects.toThrow('invalid workflow run');
  });
  it('encodes branch names as a single path component', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ commit: { sha: context.sha } })));
    vi.stubGlobal('fetch', fetch);
    expect(await client.getBranchHead('release/stable')).toBe(context.sha);
    expect(fetch.mock.calls[0]![0]).toContain('/branches/release%2Fstable');
  });
  it('does not retry permission failures or pretend missing history is safe', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 403 })); vi.stubGlobal('fetch', fetch);
    await expect(client.listArtifacts(100)).rejects.toMatchObject({ code: 'HTTP_403' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects insecure or credential-bearing API bases', () => {
    expect(() => new RepositoryApi('secret', context, 'http://api.example')).toThrow('HTTPS');
    expect(() => new RepositoryApi('secret', context, 'https://user:pass@api.example')).toThrow('HTTPS');
  });
});
