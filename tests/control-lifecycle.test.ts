import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runControl } from '../src/control/lifecycle.js';
import { invocationStep, receiptArtifact, type ControlOptions, type GitHubApi, type RunContext, type StoredArtifact, type WorkflowJob, type WorkflowRun } from '../src/control/types.js';

const context: RunContext = { owner: 'org', repo: 'extension', runId: 100, runAttempt: 1, sha: 'current-sha' };
function options(overrides: Partial<ControlOptions> = {}): ControlOptions {
  return { stage: 'plan', operation: 'upload', targets: ['chrome', 'edge'], releaseBranch: 'main', artifactName: 'extension-package', stateDir: '.browser-extension-deploy', zipPath: 'build/extension.zip', buildCommand: 'pnpm build:zip', ...overrides };
}
function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return { id: 90, workflow_id: 50, run_number: 9, status: 'completed', head_sha: context.sha, head_branch: 'main', event: 'push', run_attempt: 1, ...overrides };
}
function artifact(name = 'extension-package', overrides: Partial<StoredArtifact> = {}): StoredArtifact {
  return { id: 123, name, expired: false, ...overrides };
}
function job(target: 'chrome' | 'edge' = 'chrome', overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return { name: 'Arbitrary caller / reusable job name', status: 'completed', conclusion: 'success', steps: [{ name: invocationStep('extension-package', target), status: 'completed', conclusion: 'success' }], ...overrides };
}
function api() {
  return {
    getRun: vi.fn<GitHubApi['getRun']>().mockResolvedValue(run()),
    listRuns: vi.fn<GitHubApi['listRuns']>().mockResolvedValue([]),
    listArtifacts: vi.fn<GitHubApi['listArtifacts']>().mockResolvedValue([]),
    listJobs: vi.fn<GitHubApi['listJobs']>().mockResolvedValue([]),
    getBranchHead: vi.fn<GitHubApi['getBranchHead']>().mockResolvedValue(context.sha),
  };
}
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('deployment lifecycle plan', () => {
  it('builds an upload package and provides a ZIP basename', async () => {
    expect(await runControl(options(), context, api())).toEqual({ targets: '["chrome","edge"]', operation: 'upload', 'source-run-id': '', build: true, 'zip-file-name': 'extension.zip' });
  });
  it('does not build for status or an explicit source', async () => {
    expect(await runControl(options({ operation: 'status', buildCommand: '' }), context, api())).toMatchObject({ build: false });
    expect(await runControl(options({ operation: 'publish', sourceRunId: 90, buildCommand: '' }), context, api())).toMatchObject({ build: false, 'source-run-id': '90' });
  });
  it('requires a build command only when building', async () => {
    await expect(runControl(options({ buildCommand: ' ' }), context, api())).rejects.toThrow(/build-command/);
  });
  it('resolves the latest completed same-workflow, same-commit branch upload', async () => {
    const github = api();
    github.listRuns.mockResolvedValue([
      run({ id: 80, run_number: 8 }), run(),
      run({ id: 94, run_number: 94, head_sha: 'other' }),
      run({ id: 95, run_number: 95, head_branch: 'other' }),
      run({ id: 96, run_number: 96, workflow_id: 99 }),
      run({ id: 97, run_number: 97, event: 'workflow_dispatch' }),
      run({ id: context.runId, run_number: 100 }),
    ]);
    github.listArtifacts.mockResolvedValue([artifact()]);
    expect(await runControl(options({ operation: 'publish' }), context, github)).toMatchObject({ build: false, 'source-run-id': '90' });
    expect(github.getRun).toHaveBeenCalledWith(context.runId);
    expect(github.listRuns).toHaveBeenCalledWith(50, context.sha, 'main');
    expect(github.listArtifacts).toHaveBeenCalledWith(90);
  });
  it('omits a branch filter when branch policy is disabled', async () => {
    const github = api();
    github.listRuns.mockResolvedValue([run({ head_branch: 'release' })]);
    github.listArtifacts.mockResolvedValue([artifact()]);
    await runControl(options({ operation: 'publish', releaseBranch: '' }), context, github);
    expect(github.listRuns).toHaveBeenCalledWith(50, context.sha, undefined);
  });
  it.each([{ runs: [] }, { runs: [run({ status: 'in_progress' })] }])('rejects absent or incomplete source runs', async ({ runs }) => {
    const github = api(); github.listRuns.mockResolvedValue(runs);
    await expect(runControl(options({ operation: 'publish' }), context, github)).rejects.toThrow(/completed upload run/);
  });
  it('does not fall back to older runs when the latest source has no ZIP', async () => {
    const github = api(); github.listRuns.mockResolvedValue([run({ id: 80, run_number: 8 }), run()]);
    github.listArtifacts.mockImplementation(async (runId) => runId === 80 ? [artifact()] : []);
    await expect(runControl(options({ operation: 'publish' }), context, github)).rejects.toThrow(/Missing or expired artifact/);
    expect(github.listArtifacts).toHaveBeenCalledTimes(1);
    expect(github.listArtifacts).toHaveBeenCalledWith(90);
  });
});

describe('original package reuse', () => {
  it('reuses an existing package without inspecting jobs', async () => {
    const github = api(); github.listArtifacts.mockResolvedValue([artifact()]);
    expect(await runControl(options({ stage: 'package' }), { ...context, runAttempt: 3 }, github)).toEqual({ exists: true });
    expect(github.listJobs).not.toHaveBeenCalled();
  });
  it('permits a first build or rebuilding after failures before any invocation', async () => {
    const github = api();
    expect(await runControl(options({ stage: 'package' }), context, github)).toEqual({ exists: false });
    github.listJobs.mockResolvedValue([job('chrome', { conclusion: 'failure', steps: [
      { name: 'Download original package', status: 'completed', conclusion: 'failure' },
      { name: invocationStep('extension-package', 'chrome'), status: 'completed', conclusion: 'skipped' },
    ] })]);
    expect(await runControl(options({ stage: 'package' }), { ...context, runAttempt: 3 }, github)).toEqual({ exists: false });
    expect(github.listJobs.mock.calls).toEqual([[100, 2], [100, 1]]);
  });
  it.each(['chrome', 'edge'] as const)('blocks rebuilding after any %s invocation', async (target) => {
    const github = api(); github.listJobs.mockResolvedValue([job(target)]);
    await expect(runControl(options({ stage: 'package', targets: ['chrome'] }), { ...context, runAttempt: 2 }, github)).rejects.toThrow(/Do not rebuild/);
  });
  it('ignores checkpoints belonging to another named package', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job()]);
    expect(await runControl(options({ stage: 'package', artifactName: 'other-package' }), { ...context, runAttempt: 2 }, github)).toEqual({ exists: false });
  });
  it('does not rebuild when earlier job step history is unavailable', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job('chrome', { steps: undefined })]);
    await expect(runControl(options({ stage: 'package' }), { ...context, runAttempt: 2 }, github)).rejects.toThrow(/step history is unavailable/);
  });
  it('rejects duplicate available package artifacts', async () => {
    const github = api(); github.listArtifacts.mockResolvedValue([artifact(), artifact('extension-package', { id: 456 })]);
    await expect(runControl(options({ stage: 'package' }), context, github)).rejects.toThrow(/Multiple artifacts/);
  });
  it('requires a completed explicit source before validating its package', async () => {
    const github = api(); github.getRun.mockResolvedValue(run({ status: 'in_progress' }));
    await expect(runControl(options({ stage: 'validate-package', sourceRunId: 90 }), context, github)).rejects.toThrow(/completed before reuse/);
    expect(github.listArtifacts).not.toHaveBeenCalled();
  });
  it('validates the current or explicit source package', async () => {
    const github = api(); github.listArtifacts.mockResolvedValue([artifact()]);
    await runControl(options({ stage: 'validate-package' }), context, github);
    expect(github.listArtifacts).toHaveBeenLastCalledWith(100);
    await runControl(options({ stage: 'validate-package', sourceRunId: 90 }), context, github);
    expect(github.listArtifacts).toHaveBeenLastCalledWith(90);
  });
  it.each([{ artifacts: [] }, { artifacts: [artifact('extension-package', { expired: true })] }])('rejects a missing or expired package', async ({ artifacts }) => {
    const github = api(); github.listArtifacts.mockResolvedValue(artifacts);
    await expect(runControl(options({ stage: 'validate-package' }), context, github)).rejects.toThrow(/Missing or expired artifact/);
  });
});

describe('deployment receipt restoration', () => {
  const restoreOptions = options({ stage: 'restore', targets: ['chrome'] });
  it('permits a first upload without a receipt', async () => {
    expect(await runControl(restoreOptions, context, api())).toEqual({});
  });
  it('does not permit a first publish without an upload invocation', async () => {
    await expect(runControl({ ...restoreOptions, operation: 'publish' }, context, api())).rejects.toThrow(/prior upload invocation/);
  });
  it('identifies the checkpoint step independently of the caller job name', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job()]);
    const name = receiptArtifact('extension-package', 'chrome', 1);
    github.listArtifacts.mockResolvedValue([artifact(name)]);
    expect(await runControl(restoreOptions, { ...context, runAttempt: 2 }, github)).toEqual({ 'artifact-id': '123', 'artifact-name': name, 'run-id': '100' });
  });
  it('skips attempts where only another store or pre-checkpoint steps ran', async () => {
    const github = api();
    github.listJobs.mockImplementation(async (_runId, attempt) => attempt === 1 ? [job()] : [
      job('edge'), job('chrome', { conclusion: 'failure', steps: [{ name: invocationStep('extension-package', 'chrome'), status: 'completed', conclusion: 'skipped' }] }),
    ]);
    github.listArtifacts.mockResolvedValue([artifact(receiptArtifact('extension-package', 'chrome', 1))]);
    expect(await runControl(restoreOptions, { ...context, runAttempt: 3 }, github)).toMatchObject({ 'artifact-name': 'extension-package-state-chrome-1' });
  });
  it('does not use older snapshots if the latest store invocation lost its receipt', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job()]);
    github.listArtifacts.mockResolvedValue([artifact(receiptArtifact('extension-package', 'chrome', 1))]);
    await expect(runControl({ ...restoreOptions, sourceRunId: 90 }, { ...context, runAttempt: 3 }, github)).rejects.toThrow(/extension-package-state-chrome-2/);
    expect(github.listJobs.mock.calls).toEqual([[100, 2]]);
    expect(github.getRun).not.toHaveBeenCalled();
  });
  it('restores from the original source when this run has no invocation', async () => {
    const github = api(); github.getRun.mockResolvedValue(run({ run_attempt: 2 }));
    github.listJobs.mockImplementation(async (runId, attempt) => runId === 90 && attempt === 1 ? [job()] : [job('edge')]);
    github.listArtifacts.mockResolvedValue([artifact(receiptArtifact('extension-package', 'chrome', 1))]);
    expect(await runControl({ ...restoreOptions, operation: 'publish', sourceRunId: 90 }, { ...context, runAttempt: 2 }, github)).toMatchObject({ 'run-id': '90', 'artifact-name': 'extension-package-state-chrome-1' });
    expect(github.listJobs.mock.calls).toEqual([[100, 1], [90, 2], [90, 1]]);
  });
  it('fails if an explicit source never invoked this store', async () => {
    await expect(runControl({ ...restoreOptions, sourceRunId: 90 }, context, api())).rejects.toThrow(/no recorded chrome/);
  });
  it.each([0, -1, NaN, 1.5])('rejects an invalid source attempt %s', async (attempt) => {
    const github = api(); github.getRun.mockResolvedValue(run({ run_attempt: attempt }));
    await expect(runControl({ ...restoreOptions, sourceRunId: 90 }, context, github)).rejects.toThrow(/invalid attempt/);
  });
  it.each([{ jobs: [job(), job()] }, { jobs: [job('chrome', { status: 'in_progress' })] }])('rejects ambiguous or unfinished invoking jobs', async ({ jobs }) => {
    const github = api(); github.listJobs.mockResolvedValue(jobs);
    await expect(runControl(restoreOptions, { ...context, runAttempt: 2 }, github)).rejects.toThrow(/one completed chrome/);
  });
  it('treats a failed checkpoint as an invocation requiring its own snapshot', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job('chrome', { conclusion: 'failure', steps: [{ name: invocationStep('extension-package', 'chrome'), status: 'completed', conclusion: 'failure' }] })]);
    await expect(runControl(restoreOptions, { ...context, runAttempt: 2 }, github)).rejects.toThrow(/Missing or expired artifact/);
  });
  it('does not assume there was no invocation when step history is missing', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job('chrome', { steps: undefined })]);
    await expect(runControl(restoreOptions, { ...context, runAttempt: 2 }, github)).rejects.toThrow(/step history is unavailable/);
  });
  it('permits explicitly skipped jobs without step history', async () => {
    const github = api(); github.listJobs.mockResolvedValue([job('chrome', { conclusion: 'skipped', steps: undefined })]);
    expect(await runControl(restoreOptions, { ...context, runAttempt: 2 }, github)).toEqual({});
  });
  it('rejects a multi-target restore', async () => {
    await expect(runControl(options({ stage: 'restore' }), context, api())).rejects.toThrow(/exactly one/);
  });
});

describe('invocation checkpoint and write guard', () => {
  it('writes a complete invocation checkpoint without temporary leftovers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'control-checkpoint-')); temporaryDirectories.push(directory);
    const stateDir = path.join(directory, 'nested', 'state');
    await runControl(options({ stage: 'checkpoint', targets: ['edge'], operation: 'publish', sourceRunId: 90, stateDir }), { ...context, runAttempt: 3 }, api());
    expect(JSON.parse(await readFile(path.join(stateDir, 'invocation.json'), 'utf8'))).toEqual({ schemaVersion: 1, runId: 100, runAttempt: 3, target: 'edge', operation: 'publish', sourceRunId: 90, artifactName: 'extension-package' });
    expect(await readdir(stateDir)).toEqual(['invocation.json']);
  });
  it('rejects a multi-target checkpoint', async () => {
    await expect(runControl(options({ stage: 'checkpoint' }), context, api())).rejects.toThrow(/exactly one/);
  });
  it('allows read-only status without consulting branch or source', async () => {
    const github = api();
    expect(await runControl(options({ stage: 'guard', operation: 'status', sourceRunId: 90 }), context, github)).toEqual({});
    expect(github.getBranchHead).not.toHaveBeenCalled(); expect(github.getRun).not.toHaveBeenCalled();
  });
  it('rejects older commits immediately before store writes', async () => {
    const github = api(); github.getBranchHead.mockResolvedValue('new-main-sha');
    await expect(runControl(options({ stage: 'guard' }), context, github)).rejects.toThrow(/current main commit/);
  });
  it('allows the configured branch head and its original upload', async () => {
    const github = api();
    await runControl(options({ stage: 'guard', releaseBranch: 'release', sourceRunId: 90 }), context, github);
    expect(github.getBranchHead).toHaveBeenCalledWith('release'); expect(github.getRun).toHaveBeenCalledWith(90);
  });
  it('keeps source commit matching when the latest-branch policy is disabled', async () => {
    const github = api(); github.getRun.mockResolvedValue(run({ head_sha: 'other-sha' }));
    await expect(runControl(options({ stage: 'guard', releaseBranch: '', sourceRunId: 90 }), context, github)).rejects.toThrow(/match this deployment commit/);
    expect(github.getBranchHead).not.toHaveBeenCalled();
  });
  it('blocks an incomplete source immediately before store writes', async () => {
    const github = api(); github.getRun.mockResolvedValue(run({ status: 'in_progress' }));
    await expect(runControl(options({ stage: 'guard', sourceRunId: 90 }), context, github)).rejects.toThrow(/completed before reuse/);
  });
  it('allows disabling branch policy without a source', async () => {
    const github = api();
    await runControl(options({ stage: 'guard', releaseBranch: '' }), context, github);
    expect(github.getBranchHead).not.toHaveBeenCalled();
  });
});
