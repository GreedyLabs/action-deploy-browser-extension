import { getInput, info, setFailed } from '@actions/core';
import { type DeployOptions } from './deploy.js';
import { ChromeWebStoreTarget } from './targets/chrome.js';
import { EdgeAddonsTarget } from './targets/edge.js';

const VALID_TARGETS = ['chrome', 'edge'] as const;
type Target = typeof VALID_TARGETS[number];

function parseTargets(raw: string): Target[] {
  const targets = raw.split(',').map((t) => t.trim().toLowerCase());
  const invalid = targets.filter((t) => !VALID_TARGETS.includes(t as Target));
  if (invalid.length > 0) {
    throw new Error(`Unknown target(s): ${invalid.join(', ')}. Valid targets: ${VALID_TARGETS.join(', ')}`);
  }
  return targets as Target[];
}

async function run(): Promise<void> {
  try {
    const zipPath = getInput('zip-path', { required: true });
    const targets = parseTargets(getInput('targets', { required: true }));
    const shouldPublish = getInput('publish').trim().toLowerCase() === 'true';
    const options: DeployOptions = { zipPath, shouldPublish };

    const chromeExtensionId = getInput('chrome-extension-id');
    const edgeProductId = getInput('edge-product-id');

    info(`Targets: ${targets.join(', ')} | zip: ${zipPath} | publish: ${shouldPublish}`);

    await Promise.all(
      targets.map((target): Promise<void> => {
        switch (target) {
          case 'chrome': return new ChromeWebStoreTarget(chromeExtensionId).run(options);
          case 'edge': return new EdgeAddonsTarget(edgeProductId).run(options);
        }
      }),
    );

    info(`✓ Successfully deployed to: ${targets.join(', ')}`);
  } catch (err) {
    setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
