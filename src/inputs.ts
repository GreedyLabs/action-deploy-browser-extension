import { getInput } from '@actions/core';
import { TARGETS, type ActionInputs, type Operation, type Target } from './types.js';

export const VALID_TARGETS = TARGETS;
export type { Target, ActionInputs } from './types.js';

export function parseTargets(raw: string): Target[] {
  const targets = [...new Set(raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (!targets.length) throw new Error('At least one target is required.');
  const invalid = targets.filter((t) => !VALID_TARGETS.includes(t as Target));
  if (invalid.length > 0) {
    throw new Error(`Unknown target(s): ${invalid.join(', ')}. Valid targets: ${VALID_TARGETS.join(', ')}`);
  }
  return targets as Target[];
}

export function getInputs(): ActionInputs {
  const rawOperation = getInput('operation').trim().toLowerCase();
  const publish = getInput('publish').trim().toLowerCase();
  if (publish && !['true', 'false'].includes(publish)) throw new Error('publish must be true or false.');
  const operation = rawOperation || (publish === 'true' ? 'deploy' : 'upload');
  if (!['status', 'upload', 'publish', 'deploy'].includes(operation)) throw new Error('operation must be status, upload, publish, or deploy.');
  if (publish === 'true' && ['status', 'upload'].includes(operation)) throw new Error('publish=true conflicts with the selected operation.');
  return {
    zipPath: getInput('zip-path', { required: operation !== 'status' }),
    targets: parseTargets(getInput('targets', { required: true })),
    operation: operation as Operation,
    chromeExtensionId: getInput('chrome-extension-id'),
    chromePublisherId: getInput('chrome-publisher-id'),
    edgeProductId: getInput('edge-product-id'),
    stateDir: getInput('state-dir') || '.browser-extension-deploy',
    requestTimeoutMs: numericInput('request-timeout-seconds', 30, 1, 120) * 1000,
    pollTimeoutMs: numericInput('poll-timeout-seconds', 300, 1, 3600) * 1000,
    pollIntervalMs: numericInput('poll-interval-seconds', 5, 1, 60) * 1000,
    maxAttempts: numericInput('max-attempts', 3, 1, 10),
  };
}

function numericInput(name: string, fallback: number, min: number, max: number): number {
  const raw = getInput(name);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
