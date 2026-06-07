import { summary } from '@actions/core';
import { type DeployResult } from './targets/base.js';

/**
 * Writes a per-target results table to the GitHub Actions job summary so the
 * outcome is visible at a glance in the Actions/PR UI. Best-effort and purely
 * additive: it does not affect deploy behaviour, outputs, or exit status. When
 * `GITHUB_STEP_SUMMARY` is not set (e.g. local `act` runs) it silently no-ops.
 */
export async function writeDeploySummary(results: DeployResult[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  summary.addHeading('Deploy Browser Extension', 2);
  summary.addTable([
    [
      { data: 'Target', header: true },
      { data: 'Upload', header: true },
      { data: 'Publish', header: true },
    ],
    ...results.map((r) => [r.target, r.upload, r.publish ?? '— (skipped)']),
  ]);
  await summary.write();
}
