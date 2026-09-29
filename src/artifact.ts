import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { DeployError, type Artifact } from './types.js';

export async function inspectArtifact(file: string): Promise<Artifact> {
  const bytes = await readFile(file);
  let manifest: { version?: unknown };
  try {
    let count = 0;
    const files = unzipSync(bytes, { filter: (entry) => {
      if (entry.name !== 'manifest.json') return false;
      count += 1;
      if (entry.originalSize > 1024 * 1024) throw new Error('Manifest exceeds 1 MiB.');
      return true;
    } });
    if (count !== 1 || !files['manifest.json']) throw new Error('Expected one manifest.json at the ZIP root.');
    manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8')) as { version?: unknown };
  } catch {
    throw new DeployError('INVALID_PACKAGE', 'The ZIP must contain exactly one valid manifest.json at its root (maximum 1 MiB).');
  }
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version) ||
      version.split('.').some((part) => Number(part) > 65535) || !version.split('.').some((part) => Number(part) > 0)) {
    throw new DeployError('INVALID_VERSION', 'manifest.json must have a valid numeric extension version (1–4 parts, each 0–65535, not all zero).');
  }
  return { path: path.resolve(file), version, sha256: digest(bytes) };
}

/** Verify the exact bytes immediately before sending them to the store. */
export async function readArtifactBytes(artifact: Artifact): Promise<Buffer> {
  const bytes = await readFile(artifact.path);
  if (digest(bytes) !== artifact.sha256) {
    throw new DeployError('PACKAGE_CHANGED', 'The ZIP changed after validation. Restore the original artifact before retrying.', 'blocked');
  }
  return bytes;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
