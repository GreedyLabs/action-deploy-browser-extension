import { info } from '@actions/core';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpClient } from '../http.js';
import { DeployError, type ActionInputs, type Artifact, type DeployContext, type DeployResult, type Receipt, type StepRecord, type Target } from '../types.js';

export type { DeployResult } from '../types.js';
export type Log = (message: string) => void;

export abstract class DeployTarget {
  constructor(readonly target: Target, readonly name: string, readonly itemId: string) {}
  abstract validate(): void;
  abstract execute(context: DeployContext): Promise<void>;

  async run(options: ActionInputs, artifact?: Artifact): Promise<DeployResult> {
    const result: DeployResult = { target: this.target, name: this.name, operation: options.operation, outcome: 'success', phase: 'validate', version: artifact?.version, sha256: artifact?.sha256 };
    try {
      this.validate();
      const key = createHash('sha256').update(this.itemId).digest('hex').slice(0, 16);
      const statePath = path.resolve(options.stateDir, `${this.target}-${key}.json`);
      result.statePath = statePath;
      let receipt = await readReceipt(statePath, this.target, this.itemId);
      if (receipt && artifact) {
        if (receipt.version === artifact.version && receipt.sha256 !== artifact.sha256) {
          throw new DeployError('PACKAGE_CONFLICT', 'This version already has a different ZIP fingerprint in the saved deployment record. Reuse the original artifact or increment the version.', 'blocked');
        }
        if (receipt.version !== artifact.version) {
          if ([receipt.upload, receipt.publish].some((step) => step?.state === 'pending' || step?.state === 'uncertain')) {
            throw new DeployError('PREVIOUS_OPERATION_PENDING', 'A different version has an unfinished operation. Check its status or resume it with the original ZIP first.', 'blocked');
          }
          receipt = undefined;
        }
      }
      const context: DeployContext = {
        options, artifact, receipt, result, http: new HttpClient(options),
        log: (message) => info(`[${this.name}] ${message}`),
        record: async (phase, step) => {
          if (!context.receipt) {
            if (!artifact) throw new DeployError('MISSING_ARTIFACT', 'An artifact is required to create a deployment record.');
            context.receipt = { schemaVersion: 1, target: this.target, itemId: this.itemId, version: artifact.version, sha256: artifact.sha256 };
          }
          context.receipt[phase] = step;
          updateResult(result, context.receipt);
          await mkdir(path.dirname(statePath), { recursive: true });
          const temporary = `${statePath}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(context.receipt, null, 2)  }\n`, { mode: 0o600 });
          await rename(temporary, statePath);
        },
      };
      if (receipt) updateResult(result, receipt);
      await this.execute(context);
    } catch (error) {
      result.outcome = error instanceof DeployError ? error.outcome : 'failed';
      result.error = { code: error instanceof DeployError ? error.code : 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : String(error) };
      result.message = result.error.message;
    }
    return result;
  }
}

function updateResult(result: DeployResult, receipt: Receipt): void {
  result.version = receipt.version;
  result.sha256 = receipt.sha256;
  result.upload = receipt.upload?.state;
  result.publish = receipt.publish?.state;
  result.uploadOperationId = receipt.upload?.operationId;
  result.publishOperationId = receipt.publish?.operationId;
}

async function readReceipt(file: string, target: Target, itemId: string): Promise<Receipt | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let receipt: Receipt;
  try { receipt = JSON.parse(text) as Receipt; }
  catch { throw new DeployError('INVALID_STATE', 'The saved deployment record is not valid JSON.'); }
  const validStep = (step: StepRecord | undefined): boolean => !step || (
    ['pending', 'succeeded', 'failed', 'uncertain'].includes(step.state) &&
    (step.operationId === undefined || typeof step.operationId === 'string') &&
    (step.message === undefined || typeof step.message === 'string')
  );
  if (!receipt || receipt.schemaVersion !== 1 || receipt.target !== target || receipt.itemId !== itemId ||
    typeof receipt.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(receipt.version) ||
    typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !validStep(receipt.upload) || !validStep(receipt.publish)) {
    throw new DeployError('INVALID_STATE', 'The saved deployment record does not match this store and item or has invalid fields.');
  }
  return receipt;
}
