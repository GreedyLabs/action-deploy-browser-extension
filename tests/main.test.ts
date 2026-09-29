import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getInputs: vi.fn(), inspectArtifact: vi.fn(), chrome: vi.fn(), edge: vi.fn(), setOutput: vi.fn(), setFailed: vi.fn(), summary: vi.fn() }));
vi.mock('@actions/core', () => ({ info: vi.fn(), setOutput: mocks.setOutput, setFailed: mocks.setFailed }));
vi.mock('../src/inputs.js', () => ({ getInputs: mocks.getInputs }));
vi.mock('../src/artifact.js', () => ({ inspectArtifact: mocks.inspectArtifact }));
vi.mock('../src/targets/chrome.js', () => ({ ChromeWebStoreTarget: class { run = mocks.chrome; } }));
vi.mock('../src/targets/edge.js', () => ({ EdgeAddonsTarget: class { run = mocks.edge; } }));
vi.mock('../src/summary.js', () => ({ writeDeploySummary: mocks.summary }));
import { run as runAction } from '../src/main.js';
import { options } from './helpers.js';
import type { DeployResult } from '../src/types.js';
afterEach(() => vi.resetAllMocks());
const success: DeployResult = { target: 'edge', name: 'Edge', operation: 'upload', phase: 'upload', outcome: 'success', upload: 'succeeded', uploadOperationId: 'edge-op' };
it('waits for both stores and reports partial success after one adapter rejects', async () => {
  mocks.getInputs.mockReturnValue(options('/tmp/state')); mocks.inspectArtifact.mockResolvedValue({ version: '1', sha256: 'a' });
  mocks.chrome.mockRejectedValue(new Error('Chrome failure'));
  mocks.edge.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return success; });
  await runAction();
  const raw = mocks.setOutput.mock.calls.find(([key]) => key === 'results')![1] as string;
  expect(JSON.parse(raw)).toEqual([expect.objectContaining({ target: 'chrome', outcome: 'failed' }), success]);
  expect(mocks.setOutput).toHaveBeenCalledWith('edge-operation-id', 'edge-op');
  expect(mocks.setOutput).toHaveBeenCalledWith('failed-targets', 'chrome');
  expect(mocks.summary).toHaveBeenCalledOnce(); expect(mocks.setFailed).toHaveBeenCalledOnce();
});
it('reports pending as incomplete instead of claiming deployment success', async () => {
  mocks.getInputs.mockReturnValue(options('/tmp/state', { targets: ['edge'] }));
  mocks.edge.mockResolvedValue({ ...success, outcome: 'pending', message: 'Store processing' });
  await runAction(); expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'pending'); expect(mocks.setFailed).toHaveBeenCalled();
});
it('does not require ZIP inspection for status', async () => {
  mocks.getInputs.mockReturnValue(options('/tmp/state', { targets: ['edge'], operation: 'status' })); mocks.edge.mockResolvedValue({ ...success, operation: 'status' });
  await runAction(); expect(mocks.inspectArtifact).not.toHaveBeenCalled(); expect(mocks.setFailed).not.toHaveBeenCalled();
});
