import { getInput } from '@actions/core';

export const VALID_TARGETS = ['chrome', 'edge'] as const;
export type Target = typeof VALID_TARGETS[number];

export interface ActionInputs {
  zipPath: string;
  targets: Target[];
  shouldPublish: boolean;
  chromeExtensionId: string;
  edgeProductId: string;
}

/** Parses and validates the comma-separated `targets` input. */
export function parseTargets(raw: string): Target[] {
  const targets = raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const invalid = targets.filter((t) => !VALID_TARGETS.includes(t as Target));
  if (invalid.length > 0) {
    throw new Error(`Unknown target(s): ${invalid.join(', ')}. Valid targets: ${VALID_TARGETS.join(', ')}`);
  }
  return targets as Target[];
}

/** Reads all action inputs from the environment, validating as it goes. */
export function getInputs(): ActionInputs {
  return {
    zipPath: getInput('zip-path', { required: true }),
    targets: parseTargets(getInput('targets', { required: true })),
    shouldPublish: getInput('publish').trim().toLowerCase() === 'true',
    chromeExtensionId: getInput('chrome-extension-id'),
    edgeProductId: getInput('edge-product-id'),
  };
}
