import { summary, warning } from '@actions/core';
import { type DeployResult } from './types.js';

/** Reporting must never turn a completed store operation into a failed deployment. */
export async function writeDeploySummary(results: DeployResult[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    summary.addHeading('Deploy Browser Extension', 2);
    summary.addTable([
      ['Target', 'Version', 'Phase', 'Upload', 'Publish', 'Outcome', 'Details'].map((data) => ({ data, header: true })),
      ...results.map((r) => [r.name, r.version ?? '—', r.phase, r.upload ?? '—', r.publish ?? '—', r.outcome, r.message ?? r.error?.message ?? ''].map(escapeHtml)),
    ]);
    await summary.write();
  } catch (error) {
    warning(`Could not write deployment summary: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[character]!);
}
