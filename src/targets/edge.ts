import { readArtifactBytes } from '../artifact.js';
import { DeployTarget } from './base.js';
import { requireEnv } from '../env.js';
import { HttpError } from '../http.js';
import { DeployError, type DeployContext, type StepRecord } from '../types.js';

const API_ORIGIN = 'https://api.addons.microsoftedge.microsoft.com';
const API_BASE = `${API_ORIGIN}/v1/products`;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKED_CODES = new Set(['InProgressSubmission', 'ModuleStateUnPublishable', 'UnpublishInProgress']);
type EdgePhase = 'upload' | 'publish';
interface EdgeOperation {
  id?: string;
  status?: string;
  message?: string;
  errorCode?: string | null;
  errors?: unknown;
}

export class EdgeAddonsTarget extends DeployTarget {
  constructor(private readonly productId: string) {
    super('edge', 'Microsoft Edge Add-ons', productId);
  }

  validate(): void {
    if (!this.productId) throw new DeployError('MISSING_INPUT', 'Missing input: edge-product-id');
    if (!GUID.test(this.productId)) throw new DeployError('INVALID_INPUT', 'edge-product-id must be the product GUID from Microsoft Partner Center.');
    requireEnv('EDGE_CLIENT_ID');
    requireEnv('EDGE_API_KEY');
  }

  async execute(ctx: DeployContext): Promise<void> {
    if (ctx.options.operation === 'status') {
      await this.inspect(ctx);
      return;
    }
    if (!ctx.artifact) throw new DeployError('MISSING_ARTIFACT', 'An extension ZIP is required for this operation.');
    if (ctx.receipt && (ctx.receipt.target !== 'edge' || ctx.receipt.itemId !== this.productId || ctx.receipt.version !== ctx.artifact.version || ctx.receipt.sha256 !== ctx.artifact.sha256)) {
      throw new DeployError('PACKAGE_CONFLICT', 'The saved Edge deployment record does not match this product, version, and ZIP fingerprint.', 'blocked');
    }
    if (ctx.options.operation === 'publish' && ctx.receipt?.upload?.state !== 'succeeded') {
      throw new DeployError('UPLOAD_NOT_CONFIRMED', 'Publish-only requires a matching ZIP receipt with a confirmed successful Edge upload. Upload or check the saved operation first.', 'blocked');
    }

    let changed = false;
    if (ctx.options.operation !== 'publish') changed = await this.upload(ctx);
    if (ctx.options.operation !== 'upload') changed = await this.publish(ctx) || changed;
    ctx.result.outcome = changed ? 'success' : 'skipped';
    ctx.result.message = ctx.result.phase === 'publish'
      ? 'Edge submission creation is confirmed. Certification and availability in the store are separate; this does not confirm that the extension is live.'
      : 'Edge package processing is confirmed for this ZIP. No publication was requested.';
  }

  private async upload(ctx: DeployContext): Promise<boolean> {
    ctx.result.phase = 'upload';
    const existing = ctx.receipt?.upload;
    if (existing?.state === 'succeeded') {
      ctx.result.remoteState = 'uploaded';
      ctx.log('Skipping upload: this ZIP has a confirmed successful upload receipt.');
      return false;
    }
    if (await this.resume(ctx, 'upload', existing)) return true;
    const body = await readArtifactBytes(ctx.artifact!);
    await this.start(ctx, 'upload', { 'Content-Type': 'application/zip' }, body);
    return true;
  }

  private async publish(ctx: DeployContext): Promise<boolean> {
    ctx.result.phase = 'publish';
    if (ctx.receipt?.upload?.state !== 'succeeded') {
      throw new DeployError('UPLOAD_NOT_CONFIRMED', 'Edge upload must succeed before creating a submission.', 'blocked');
    }
    const existing = ctx.receipt.publish;
    if (existing?.state === 'succeeded') {
      ctx.result.remoteState = 'submission-created';
      ctx.log('Skipping publish: submission creation is already confirmed for this ZIP.');
      return false;
    }
    if (await this.resume(ctx, 'publish', existing)) return true;
    await this.start(ctx, 'publish');
    return true;
  }

  private async resume(ctx: DeployContext, phase: EdgePhase, step?: StepRecord): Promise<boolean> {
    if (step?.state !== 'pending' && step?.state !== 'uncertain') return false;
    if (!step.operationId) {
      ctx.result.remoteState = 'unknown';
      throw new DeployError('EDGE_OPERATION_UNCERTAIN', `The previous Edge ${phase} request may have been accepted, but no operation ID was saved. Inspect this product in Partner Center and reconcile the saved receipt before retrying. This action will not automatically send the POST again.`, 'blocked');
    }
    await this.wait(ctx, phase, step.operationId);
    return true;
  }

  private async start(ctx: DeployContext, phase: EdgePhase, headers: Record<string, string> = {}, body?: Buffer): Promise<void> {
    await ctx.record(phase, { state: 'uncertain', message: `Edge ${phase} intent saved before sending the request.` });
    let response: Response;
    try {
      response = await ctx.http.request(this.endpoint(phase), {
        method: 'POST',
        headers: { ...this.authHeaders(), ...headers },
        body: body === undefined ? undefined : new Uint8Array(body),
      });
    } catch (error) {
      const reported = this.explainAuthentication(error);
      const definiteFailure = error instanceof HttpError && !error.uncertain;
      await ctx.record(phase, { state: definiteFailure ? 'failed' : 'uncertain', message: reported instanceof Error ? reported.message : String(reported) });
      throw reported;
    }
    // A 202 only acknowledges the write. Preserve the uncertain intent if the
    // response cannot provide a trustworthy operation ID for reconciliation.
    if (response.status !== 202) {
      throw new DeployError('EDGE_INVALID_RESPONSE', `Expected Edge ${phase} to return 202 Accepted, but received ${response.status}. Inspect Partner Center before retrying the write.`, 'pending');
    }
    const operationId = this.operationId(response.headers.get('Location'), phase);
    await ctx.record(phase, { state: 'pending', operationId });
    await this.wait(ctx, phase, operationId);
  }

  private async wait(ctx: DeployContext, phase: EdgePhase, operationId: string): Promise<void> {
    await ctx.http.poll(
      () => this.readOperation(ctx, phase, operationId),
      (operation) => operation.status === 'Succeeded',
    );
  }

  private async readOperation(ctx: DeployContext, phase: EdgePhase, operationId: string): Promise<EdgeOperation> {
    const id = this.operationId(operationId, phase);
    let operation: EdgeOperation;
    try {
      operation = await ctx.http.json<EdgeOperation>(`${this.endpoint(phase)}/operations/${id}`, { headers: this.authHeaders() });
    } catch (error) {
      throw this.explainAuthentication(error);
    }
    if (!operation || !['InProgress', 'Succeeded', 'Failed'].includes(operation.status ?? '') || (operation.id !== undefined && (typeof operation.id !== 'string' || operation.id.toLowerCase() !== id.toLowerCase()))) {
      throw new DeployError('EDGE_INVALID_STATUS', 'Edge returned an unrecognized operation status. The saved operation is retained; check its status again before sending a write.', 'pending');
    }
    if (operation.status === 'Failed') {
      const code = typeof operation.errorCode === 'string' && operation.errorCode ? operation.errorCode : 'OPERATION_FAILED';
      const message = [typeof operation.message === 'string' ? operation.message : 'Edge processing failed.', operation.errors ? JSON.stringify(operation.errors) : ''].filter(Boolean).join(' ').slice(0, 2000);
      const advice = code === 'InProgressSubmission'
        ? ' An existing submission is in review. Inspect Partner Center; do not assume it contains this ZIP or automatically cancel that review.'
        : code === 'ModuleStateUnPublishable' ? ' Correct the invalid modules in Partner Center before retrying publication.' : '';
      await ctx.record(phase, { state: 'failed', operationId: id, message: `${code}: ${message}${advice}` });
      ctx.result.remoteState = code;
      throw new DeployError(`EDGE_${code}`, `${message}${advice}`, BLOCKED_CODES.has(code) ? 'blocked' : 'failed');
    }
    const succeeded = operation.status === 'Succeeded';
    await ctx.record(phase, { state: succeeded ? 'succeeded' : 'pending', operationId: id, message: succeeded ? `${phase} operation succeeded` : `${phase} operation is in progress` });
    ctx.result.remoteState = succeeded ? phase === 'upload' ? 'uploaded' : 'submission-created' : `${phase}-in-progress`;
    ctx.log(`${phase} operation ${id}: ${operation.status}`);
    return operation;
  }

  private async inspect(ctx: DeployContext): Promise<void> {
    ctx.result.phase = 'status';
    ctx.result.remoteState = 'unknown';
    if (!ctx.receipt || (!ctx.receipt.upload && !ctx.receipt.publish)) {
      ctx.result.outcome = 'skipped';
      ctx.result.message = 'No saved Edge operation is available. Remote state is unknown: the public API used here cannot discover a global submission state or current package version without a saved operation ID.';
      return;
    }
    let found = false;
    let pending = false;
    let unknown = false;
    for (const phase of ['upload', 'publish'] as const) {
      const step = ctx.receipt[phase];
      if (!step) continue;
      if (!step.operationId) {
        unknown = true;
        pending ||= step.state === 'pending' || step.state === 'uncertain';
        continue;
      }
      found = true;
      const operation = await this.readOperation(ctx, phase, step.operationId);
      pending ||= operation.status === 'InProgress';
    }
    ctx.result.outcome = pending ? 'pending' : found ? 'success' : 'skipped';
    if (unknown) {
      ctx.result.remoteState = 'unknown';
      ctx.result.message = 'A saved Edge request has no operation ID, so its remote state cannot be checked. Inspect Partner Center and reconcile the receipt; no request was re-submitted.';
    } else {
      ctx.result.message = pending
        ? 'The saved Edge operation is still processing. Run status again or resume with the same ZIP.'
        : 'Saved Edge operations are confirmed. Submission creation does not confirm certification or live availability, and this API does not establish the current remote package version.';
    }
  }

  private endpoint(phase: EdgePhase): string {
    return `${API_BASE}/${this.productId}/submissions${phase === 'upload' ? '/draft/package' : ''}`;
  }

  private operationId(location: string | null, phase: EdgePhase): string {
    const value = location?.trim() ?? '';
    if (GUID.test(value)) return value;
    if (value) {
      try {
        const parsed = new URL(value, API_ORIGIN);
        const prefix = `${new URL(this.endpoint(phase)).pathname}/operations/`;
        const id = parsed.pathname.slice(prefix.length);
        if (parsed.origin === API_ORIGIN && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname.toLowerCase().startsWith(prefix.toLowerCase()) && GUID.test(id)) return id;
      } catch { /* Treat malformed operation locations as an uncertain write. */ }
    }
    throw new DeployError('EDGE_INVALID_OPERATION_ID', 'Edge did not provide a valid operation GUID or a matching same-origin operation URL. The write may have been accepted; inspect Partner Center before retrying. No credentials were sent to the returned location.', 'pending');
  }

  private explainAuthentication(error: unknown): unknown {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return new DeployError('EDGE_AUTH_FAILED', `Edge rejected the credentials (${error.status}). Check EDGE_CLIENT_ID, EDGE_API_KEY, the key expiry, and product/account permissions in Partner Center. Authentication errors are not retried.`);
    }
    return error;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `ApiKey ${requireEnv('EDGE_API_KEY')}`,
      'X-ClientID': requireEnv('EDGE_CLIENT_ID'),
    };
  }
}
