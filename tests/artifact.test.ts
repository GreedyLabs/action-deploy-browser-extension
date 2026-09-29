import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectArtifact, readArtifactBytes } from '../src/artifact.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function zip(version: unknown, name = 'manifest.json') {
  const dir = await mkdtemp(path.join(tmpdir(), 'artifact-test-')); dirs.push(dir);
  const file = path.join(dir, 'extension.zip');
  await writeFile(file, zipSync({ [name]: strToU8(JSON.stringify({ version })) }));
  return file;
}
describe('artifact identity', () => {
  it('reads root manifest and verifies the exact upload bytes', async () => {
    const artifact = await inspectArtifact(await zip('1.2.3'));
    expect(artifact).toMatchObject({ version: '1.2.3', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await readArtifactBytes(artifact)).length).toBeGreaterThan(0);
    await writeFile(artifact.path, 'changed');
    await expect(readArtifactBytes(artifact)).rejects.toMatchObject({ code: 'PACKAGE_CHANGED' });
  });
  it('rejects the old dist/manifest.json ZIP layout', async () => {
    await expect(inspectArtifact(await zip('1.0', 'dist/manifest.json'))).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
  });
  it.each(['0', '0.0.0.0', '01.1', '65536.1', '1.2.3.4.5', '1.0-beta', 1, null])('rejects invalid version %s', async (version) => {
    await expect(inspectArtifact(await zip(version))).rejects.toMatchObject({ code: 'INVALID_VERSION' });
  });
  it('rejects oversized manifest before decompressing it', async () => {
    const file = await zip('1.0');
    await writeFile(file, zipSync({ 'manifest.json': strToU8(' '.repeat(1024 * 1024 + 1)) }));
    await expect(inspectArtifact(file)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
  });
});
