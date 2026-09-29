import { info, setFailed, setOutput } from '@actions/core';
import { inspectArtifact } from './artifact.js';
import { getInputs } from './inputs.js';
import { type DeployResult, type Outcome } from './types.js';
import { ChromeWebStoreTarget } from './targets/chrome.js';
import { EdgeAddonsTarget } from './targets/edge.js';
import { writeDeploySummary } from './summary.js';

export async function run(): Promise<void> {
  let results: DeployResult[] = [];
  try {
    const options = getInputs();
    setOutput('state-dir', options.stateDir);
    const artifact = options.operation === 'status' ? undefined : await inspectArtifact(options.zipPath);
    info(`Targets: ${options.targets.join(', ')} | operation: ${options.operation} | version: ${artifact?.version ?? 'status only'}`);
    const settled = await Promise.allSettled(options.targets.map((target) => {
      const adapter = target === 'chrome'
        ? new ChromeWebStoreTarget(options.chromeExtensionId, options.chromePublisherId)
        : new EdgeAddonsTarget(options.edgeProductId);
      return adapter.run(options, artifact);
    }));
    results = settled.map((entry, index): DeployResult => entry.status === 'fulfilled' ? entry.value : {
      target: options.targets[index]!, name: options.targets[index]!, operation: options.operation,
      outcome: 'failed', phase: 'validate', error: { code: 'UNEXPECTED_ERROR', message: String(entry.reason) },
    });
    writeOutputs(results);
    await writeDeploySummary(results);
    const failed = results.filter((result) => !['success', 'skipped'].includes(result.outcome));
    if (failed.length) {
      setFailed(failed.map((result) => `${result.name}: ${result.outcome} — ${result.message ?? result.error?.message ?? result.phase}`).join('\n'));
    } else {
      info('All requested store operations completed or were already satisfied.');
    }
  } catch (error) {
    // Validation failures still produce a machine-readable outcome.
    setOutput('results', JSON.stringify(results));
    setOutput('failed-targets', results.filter((result) => !['success', 'skipped'].includes(result.outcome)).map((result) => result.target).join(','));
    setOutput('outcome', 'failed');
    await writeDeploySummary(results);
    setFailed(error instanceof Error ? error.message : String(error));
  }
}

function writeOutputs(results: DeployResult[]): void {
  const failures = results.filter((result) => !['success', 'skipped'].includes(result.outcome));
  const severity: Outcome[] = ['failed', 'blocked', 'pending'];
  const outcome = severity.find((value) => results.some((result) => result.outcome === value)) ??
    (results.every((result) => result.outcome === 'skipped') ? 'skipped' : 'success');
  setOutput('results', JSON.stringify(results));
  setOutput('failed-targets', failures.map((result) => result.target).join(','));
  setOutput('outcome', outcome);
  const chrome = results.find((result) => result.target === 'chrome');
  const edge = results.find((result) => result.target === 'edge');
  setOutput('chrome-upload-status', chrome?.upload ?? '');
  setOutput('chrome-publish-status', chrome?.publish ?? '');
  setOutput('edge-operation-id', edge?.uploadOperationId ?? '');
  setOutput('edge-publish-operation-id', edge?.publishOperationId ?? '');
}
