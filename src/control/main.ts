import { getInput, info, setFailed, setOutput, setSecret } from '@actions/core';
import { parseTargets } from '../inputs.js';
import type { Operation } from '../types.js';
import { RepositoryApi } from './github.js';
import { runControl } from './lifecycle.js';
import type { ControlOptions, ControlStage, RunContext } from './types.js';

export async function run(): Promise<void> {
  try {
    const options = readOptions();
    const context = readContext();
    const token = getInput('github-token', { required: true });
    setSecret(token);
    const api = new RepositoryApi(token, context, process.env.GITHUB_API_URL);
    info(`Deployment preparation: ${options.stage}`);
    const outputs = await runControl(options, context, api);
    for (const [name, value] of Object.entries(outputs)) setOutput(name, value);
  } catch (error) {
    setFailed(error instanceof Error ? error.message : String(error));
  }
}

export function readOptions(): ControlOptions {
  const stage = getInput('stage', { required: true });
  if (!['plan', 'package', 'validate-package', 'restore', 'checkpoint', 'guard'].includes(stage)) throw new Error('Unknown deployment preparation stage.');
  const operation = getInput('operation') || 'upload';
  if (!['status', 'upload', 'publish', 'deploy'].includes(operation)) throw new Error('operation must be status, upload, publish, or deploy.');
  const artifactName = getInput('artifact-name') || 'extension-package';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(artifactName)) throw new Error('artifact-name must be 1–100 letters, digits, dots, hyphens or underscores, starting with a letter or digit.');
  const sourceRun = getInput('source-run-id').trim();
  return {
    stage: stage as ControlStage,
    operation: operation as Operation,
    targets: parseTargets(getInput('targets') || 'chrome,edge'),
    sourceRunId: sourceRun ? positiveInteger(sourceRun, 'source-run-id') : undefined,
    releaseBranch: getInput('release-branch'),
    artifactName,
    stateDir: getInput('state-dir') || '.browser-extension-deploy',
    zipPath: getInput('zip-path') || 'extension.zip',
    buildCommand: getInput('build-command'),
  };
}

export function readContext(): RunContext {
  const repository = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (repository.length !== 2 || !repository.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('A valid GitHub repository context is required.');
  const sha = process.env.GITHUB_SHA ?? '';
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('A valid GitHub commit context is required.');
  return {
    owner: repository[0]!, repo: repository[1]!, sha,
    runId: positiveInteger(process.env.GITHUB_RUN_ID ?? '', 'GITHUB_RUN_ID'),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT ?? '1', 'GITHUB_RUN_ATTEMPT'),
  };
}

function positiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}
