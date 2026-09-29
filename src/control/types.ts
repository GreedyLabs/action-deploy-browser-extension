import type { Operation, Target } from '../types.js';

export type ControlStage = 'plan' | 'package' | 'validate-package' | 'restore' | 'checkpoint' | 'guard';
export interface ControlOptions {
  stage: ControlStage;
  operation: Operation;
  targets: Target[];
  sourceRunId?: number;
  releaseBranch: string;
  artifactName: string;
  stateDir: string;
  zipPath: string;
  buildCommand: string;
}
export interface RunContext {
  owner: string;
  repo: string;
  runId: number;
  runAttempt: number;
  sha: string;
}
export interface WorkflowRun {
  id: number;
  run_number: number;
  status: string;
  head_sha: string;
  head_branch: string;
  event: string;
  run_attempt: number;
  workflow_id: number;
}
export interface StoredArtifact { id: number; name: string; expired: boolean }
export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string | null;
  steps?: Array<{ name: string; status?: string; conclusion?: string | null }>;
}
export interface GitHubApi {
  getRun(runId: number): Promise<WorkflowRun>;
  listRuns(workflowId: number, sha: string, branch?: string): Promise<WorkflowRun[]>;
  listArtifacts(runId: number): Promise<StoredArtifact[]>;
  listJobs(runId: number, attempt: number): Promise<WorkflowJob[]>;
  getBranchHead(branch: string): Promise<string>;
}
export type ControlOutputs = Record<string, string | boolean>;

/** Stable internal step name, independent of the caller's job/workflow display names. */
export function invocationStep(artifactName: string, target: Target): string {
  return `Record deployment invocation (${artifactName}/${target})`;
}
export function receiptArtifact(artifactName: string, target: Target, attempt: number): string {
  return `${artifactName}-state-${target}-${attempt}`;
}
