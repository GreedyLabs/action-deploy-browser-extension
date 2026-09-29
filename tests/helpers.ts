import type { ActionInputs } from '../src/types.js';
export function options(stateDir: string, overrides: Partial<ActionInputs> = {}): ActionInputs {
  return { zipPath: 'dist.zip', targets: ['chrome', 'edge'], operation: 'upload', chromeExtensionId: 'chrome-id', chromePublisherId: 'publisher-id', edgeProductId: 'edge-id', stateDir, requestTimeoutMs: 1000, pollTimeoutMs: 100, pollIntervalMs: 1, maxAttempts: 1, ...overrides };
}
