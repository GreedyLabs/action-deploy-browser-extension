import type { HttpClient } from './http.js';

export const TARGETS = ['chrome', 'edge'] as const;
export type Target = typeof TARGETS[number];
export type Operation = 'status' | 'upload' | 'publish' | 'deploy';
export type Phase = 'validate' | 'status' | 'upload' | 'publish';
export type Outcome = 'success' | 'skipped' | 'pending' | 'blocked' | 'failed';

export interface ActionInputs {
  zipPath: string;
  targets: Target[];
  operation: Operation;
  chromeExtensionId: string;
  chromePublisherId: string;
  edgeProductId: string;
  stateDir: string;
  requestTimeoutMs: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
}
export interface Artifact {
  path: string;
  version: string;
  sha256: string;
}
export interface StepRecord {
  state: 'pending' | 'succeeded' | 'failed' | 'uncertain';
  operationId?: string;
  message?: string;
}
export interface Receipt {
  schemaVersion: 1;
  target: Target;
  itemId: string;
  version: string;
  sha256: string;
  upload?: StepRecord;
  publish?: StepRecord;
}
export interface DeployResult {
  target: Target;
  name: string;
  operation: Operation;
  outcome: Outcome;
  phase: Phase;
  version?: string;
  sha256?: string;
  upload?: string;
  publish?: string;
  remoteState?: string;
  message?: string;
  error?: { code: string; message: string };
  uploadOperationId?: string;
  publishOperationId?: string;
  statePath?: string;
}
export interface DeployContext {
  options: ActionInputs;
  artifact?: Artifact;
  receipt?: Receipt;
  result: DeployResult;
  http: HttpClient;
  log: (message: string) => void;
  /** Atomically persist intent before a write, then operation IDs and terminal outcomes. */
  record: (phase: 'upload' | 'publish', step: StepRecord) => Promise<void>;
}
export class DeployError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: Outcome = 'failed') {
    super(message);
    this.name = 'DeployError';
  }
}
