import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeployTarget } from '../src/targets/base.js';
import { DeployError, type Artifact, type DeployContext } from '../src/types.js';
import { options } from './helpers.js';
vi.mock('@actions/core', () => ({ info: vi.fn() }));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const artifact: Artifact = { path: 'zip', version: '1.2', sha256: 'a'.repeat(64) };
class FakeTarget extends DeployTarget {
  execute = vi.fn<(ctx: DeployContext) => Promise<void>>();
  constructor() { super('edge', 'Edge', 'product'); }
  validate() {}
}
async function setup() { const dir = await mkdtemp(path.join(tmpdir(), 'receipt-test-')); dirs.push(dir); return options(dir); }
describe('durable deployment records', () => {
  it('keeps upload success when publishing fails, and reloads it on retry', async () => {
    const opts = await setup(); const first = new FakeTarget();
    first.execute.mockImplementation(async (ctx) => {
      await ctx.record('upload', { state: 'succeeded', operationId: 'op-1' });
      ctx.result.phase = 'publish'; throw new DeployError('PUBLISH_FAILED', 'Rejected');
    });
    const result = await first.run(opts, artifact);
    expect(result).toMatchObject({ outcome: 'failed', upload: 'succeeded', uploadOperationId: 'op-1', phase: 'publish' });
    expect(JSON.parse(await readFile(result.statePath!, 'utf8')).upload.state).toBe('succeeded');
    const retry = new FakeTarget(); retry.execute.mockImplementation(async (ctx) => { expect(ctx.receipt?.upload?.operationId).toBe('op-1'); });
    expect((await retry.run(opts, artifact)).outcome).toBe('success');
  });
  it('blocks the same version with different ZIP bytes', async () => {
    const opts = await setup(); const target = new FakeTarget();
    target.execute.mockImplementation(async (ctx) => ctx.record('upload', { state: 'succeeded' }));
    await target.run(opts, artifact); target.execute.mockClear();
    expect(await target.run(opts, { ...artifact, sha256: 'b'.repeat(64) })).toMatchObject({ outcome: 'blocked', error: { code: 'PACKAGE_CONFLICT' } });
    expect(target.execute).not.toHaveBeenCalled();
  });
  it('blocks a new version while a previous operation is unresolved', async () => {
    const opts = await setup(); const target = new FakeTarget();
    target.execute.mockImplementation(async (ctx) => ctx.record('upload', { state: 'uncertain' }));
    await target.run(opts, artifact); target.execute.mockClear();
    expect(await target.run(opts, { ...artifact, version: '2' })).toMatchObject({ outcome: 'blocked', error: { code: 'PREVIOUS_OPERATION_PENDING' } });
    expect(target.execute).not.toHaveBeenCalled();
  });
});
