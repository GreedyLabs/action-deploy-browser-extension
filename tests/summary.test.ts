import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ addHeading: vi.fn(), addTable: vi.fn(), write: vi.fn(), warning: vi.fn() }));
vi.mock('@actions/core', () => ({ summary: mocks, warning: mocks.warning }));
import { writeDeploySummary } from '../src/summary.js';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('never fails a deployment when the summary file is unavailable', async () => {
  vi.stubEnv('GITHUB_STEP_SUMMARY', '/missing'); mocks.write.mockRejectedValueOnce(new Error('disk error'));
  await expect(writeDeploySummary([])).resolves.toBeUndefined(); expect(mocks.warning).toHaveBeenCalled();
});
it('escapes remote error text instead of inserting HTML into the summary', async () => {
  vi.stubEnv('GITHUB_STEP_SUMMARY', '/summary'); mocks.write.mockResolvedValueOnce(undefined);
  await writeDeploySummary([{ target: 'edge', name: 'Edge', phase: 'upload', operation: 'upload', outcome: 'failed', message: '<script>error</script>' }]);
  expect(JSON.stringify(mocks.addTable.mock.calls)).toContain('&lt;script&gt;error&lt;/script&gt;');
});
