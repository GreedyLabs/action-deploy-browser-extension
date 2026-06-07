import { info, setFailed } from '@actions/core';
import { getInputs } from './inputs.js';
import { type DeployOptions, type DeployResult } from './targets/base.js';
import { ChromeWebStoreTarget } from './targets/chrome.js';
import { EdgeAddonsTarget } from './targets/edge.js';
import { writeDeploySummary } from './summary.js';

export async function run(): Promise<void> {
  try {
    const { zipPath, targets, shouldPublish, chromeExtensionId, edgeProductId } = getInputs();
    const options: DeployOptions = { zipPath, shouldPublish };

    info(`Targets: ${targets.join(', ')} | zip: ${zipPath} | publish: ${shouldPublish}`);

    const results = await Promise.all(
      targets.map((target): Promise<DeployResult> => {
        switch (target) {
          case 'chrome': return new ChromeWebStoreTarget(chromeExtensionId).run(options);
          case 'edge': return new EdgeAddonsTarget(edgeProductId).run(options);
        }
      }),
    );

    await writeDeploySummary(results);
    info(`✓ Successfully deployed to: ${targets.join(', ')}`);
  } catch (err) {
    setFailed(err instanceof Error ? err.message : String(err));
  }
}
