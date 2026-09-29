import { afterEach, describe, expect, it, vi } from 'vitest';
import { readContext, readOptions } from '../src/control/main.js';
afterEach(() => vi.unstubAllEnvs());
function input(name: string, value: string) { vi.stubEnv(`INPUT_${name.toUpperCase()}`, value); }

describe('internal workflow inputs', () => {
  it('validates targets and keeps branch policy optional', () => {
    input('stage', 'plan'); input('targets', 'edge,chrome,edge'); input('release-branch', '');
    expect(readOptions()).toMatchObject({ stage: 'plan', targets: ['edge', 'chrome'], operation: 'upload', artifactName: 'extension-package', releaseBranch: '' });
  });
  it.each(['-1', '1.2', '1e5', 'NaN', '9007199254740992'])('rejects invalid source run %s', (value) => {
    input('stage', 'restore'); input('source-run-id', value);
    expect(() => readOptions()).toThrow('positive integer');
  });
  it('does not allow a path or expression as an artifact namespace', () => {
    input('stage', 'plan'); input('artifact-name', '../other-package');
    expect(() => readOptions()).toThrow('artifact-name');
  });
  it('rejects unsupported stages', () => {
    input('stage', 'unknown'); expect(() => readOptions()).toThrow('Unknown');
  });
  it('requires a real workflow execution context', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/extension'); vi.stubEnv('GITHUB_SHA', 'a'.repeat(40));
    vi.stubEnv('GITHUB_RUN_ID', '123'); vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
    expect(readContext()).toMatchObject({ owner: 'owner', repo: 'extension', runId: 123, runAttempt: 2 });
    vi.stubEnv('GITHUB_RUN_ID', ''); expect(() => readContext()).toThrow('GITHUB_RUN_ID');
  });
});
