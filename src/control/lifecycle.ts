import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TARGETS, type Target } from '../types.js';
import { invocationStep, receiptArtifact, type ControlOptions, type ControlOutputs, type GitHubApi, type RunContext, type StoredArtifact } from './types.js';

export async function runControl(options: ControlOptions, context: RunContext, api: GitHubApi): Promise<ControlOutputs> {
  switch (options.stage) {
    case 'plan': return plan(options, context, api);
    case 'package': return checkPackage(options, context, api);
    case 'validate-package': {
      const runId = options.sourceRunId ?? context.runId;
      if (options.sourceRunId) await requireCompletedRun(api, runId);
      await requireArtifact(api, runId, options.artifactName);
      return {};
    }
    case 'restore': return restore(options, context, api);
    case 'checkpoint': return checkpoint(options, context);
    case 'guard': return guard(options, context, api);
  }
}

async function plan(options: ControlOptions, context: RunContext, api: GitHubApi): Promise<ControlOutputs> {
  let sourceRunId = options.sourceRunId;
  if (options.operation === 'publish' && !sourceRunId) {
    const current = await api.getRun(context.runId);
    const runs = await api.listRuns(current.workflow_id, context.sha, options.releaseBranch || undefined);
    const source = runs.filter((run) => run.id !== context.runId && run.workflow_id === current.workflow_id &&
      run.head_sha === context.sha && run.event === 'push' && (!options.releaseBranch || run.head_branch === options.releaseBranch))
      .sort((a, b) => b.run_number - a.run_number)[0];
    if (!source || source.status !== 'completed') {
      throw new Error('Publication requires a completed upload run for this workflow and commit. Complete that run or provide source-run-id.');
    }
    // Missing artifacts in the newest matching run must never select an older draft implicitly.
    await requireArtifact(api, source.id, options.artifactName);
    sourceRunId = source.id;
  }
  const build = options.operation !== 'status' && !sourceRunId;
  if (build && !options.buildCommand.trim()) throw new Error('build-command is required when creating an extension package.');
  return {
    targets: JSON.stringify(options.targets), operation: options.operation,
    'source-run-id': sourceRunId ? String(sourceRunId) : '', build,
    'zip-file-name': path.basename(options.zipPath),
  };
}

async function checkPackage(options: ControlOptions, context: RunContext, api: GitHubApi): Promise<ControlOutputs> {
  const available = await findArtifact(api, context.runId, options.artifactName);
  if (available) return { exists: true };
  for (let attempt = context.runAttempt - 1; attempt >= 1; attempt--) {
    const jobs = await jobsWithStepHistory(api, context.runId, attempt);
    if (jobs.some((job) => TARGETS.some((target) => job.steps?.some((step) =>
      step.name === invocationStep(options.artifactName, target) && stepStarted(step))))) {
      throw new Error('The original extension package is missing or expired after a store invocation. Do not rebuild the same version to resume it.');
    }
  }
  return { exists: false };
}

async function restore(options: ControlOptions, context: RunContext, api: GitHubApi): Promise<ControlOutputs> {
  const target = singleTarget(options);
  let runId = context.runId;
  let attempt = await lastInvocation(api, runId, context.runAttempt - 1, options.artifactName, target);
  if (attempt === undefined && options.sourceRunId) {
    runId = options.sourceRunId;
    const source = await requireCompletedRun(api, runId);
    if (!Number.isSafeInteger(source.run_attempt) || source.run_attempt < 1) throw new Error('The source run has an invalid attempt number.');
    attempt = await lastInvocation(api, runId, source.run_attempt, options.artifactName, target);
    if (attempt === undefined) throw new Error(`The source run has no recorded ${target} deployment invocation.`);
  }
  if (attempt === undefined) {
    if (options.operation === 'publish') throw new Error('Publication requires a prior upload invocation and its deployment receipt.');
    return {};
  }
  const name = receiptArtifact(options.artifactName, target, attempt);
  const artifact = await requireArtifact(api, runId, name);
  return { 'artifact-id': String(artifact.id), 'artifact-name': artifact.name, 'run-id': String(runId) };
}

async function lastInvocation(api: GitHubApi, runId: number, lastAttempt: number, artifactName: string, target: Target): Promise<number | undefined> {
  for (let attempt = lastAttempt; attempt >= 1; attempt--) {
    const jobs = await jobsWithStepHistory(api, runId, attempt);
    const matches = jobs.filter((job) => job.steps?.some((step) => step.name === invocationStep(artifactName, target) && stepStarted(step)));
    if (!matches.length) continue;
    if (matches.length !== 1 || matches[0]!.status !== 'completed') {
      throw new Error(`Cannot establish one completed ${target} deployment invocation in run ${runId}, attempt ${attempt}.`);
    }
    return attempt;
  }
  return undefined;
}

function stepStarted(step: { status?: string; conclusion?: string | null }): boolean {
  return step.conclusion !== 'skipped' && (step.status === 'in_progress' || step.status === 'completed');
}

async function jobsWithStepHistory(api: GitHubApi, runId: number, attempt: number): ReturnType<GitHubApi['listJobs']> {
  const jobs = await api.listJobs(runId, attempt);
  if (jobs.some((job) => !Array.isArray(job.steps) && job.conclusion !== 'skipped')) {
    throw new Error(`Deployment step history is unavailable for run ${runId}, attempt ${attempt}; cannot safely establish whether a store was invoked.`);
  }
  return jobs;
}

async function checkpoint(options: ControlOptions, context: RunContext): Promise<ControlOutputs> {
  const target = singleTarget(options);
  await mkdir(options.stateDir, { recursive: true });
  const destination = path.join(options.stateDir, 'invocation.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    schemaVersion: 1, runId: context.runId, runAttempt: context.runAttempt, target,
    operation: options.operation, sourceRunId: options.sourceRunId, artifactName: options.artifactName,
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return {};
}

async function guard(options: ControlOptions, context: RunContext, api: GitHubApi): Promise<ControlOutputs> {
  if (options.operation === 'status') return {};
  if (options.releaseBranch) {
    const head = await api.getBranchHead(options.releaseBranch);
    if (context.sha !== head) throw new Error(`Store writes require the current ${options.releaseBranch} commit. Older runs cannot replace the current draft.`);
  }
  if (options.sourceRunId) {
    const source = await requireCompletedRun(api, options.sourceRunId);
    if (source.head_sha !== context.sha) throw new Error('The source upload run must match this deployment commit.');
  }
  return {};
}

function singleTarget(options: ControlOptions): Target {
  if (options.targets.length !== 1) throw new Error(`${options.stage} requires exactly one deployment target.`);
  return options.targets[0]!;
}

async function requireCompletedRun(api: GitHubApi, runId: number): ReturnType<GitHubApi['getRun']> {
  const run = await api.getRun(runId);
  if (run.status !== 'completed') throw new Error('The source upload run must be completed before reuse.');
  return run;
}

async function findArtifact(api: GitHubApi, runId: number, name: string): Promise<StoredArtifact | undefined> {
  const matches = (await api.listArtifacts(runId)).filter((artifact) => artifact.name === name && !artifact.expired);
  if (matches.length > 1) throw new Error(`Multiple artifacts named ${name} exist in run ${runId}; cannot safely select one.`);
  return matches[0];
}

async function requireArtifact(api: GitHubApi, runId: number, name: string): Promise<StoredArtifact> {
  const artifact = await findArtifact(api, runId, name);
  if (!artifact) throw new Error(`Missing or expired artifact ${name} in run ${runId}. Do not fall back to an older snapshot or rebuild the same version; specify the original source-run-id and inspect the store before resuming.`);
  return artifact;
}
