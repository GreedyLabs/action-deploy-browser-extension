import { DeployTarget } from './base.js';
import { readArtifactBytes } from '../artifact.js';
import { requireEnv } from '../env.js';
import { createGoogleAccessToken } from '../google-auth.js';
import { DeployError, type DeployContext } from '../types.js';
import { HttpError } from '../http.js';

const API_BASE = 'https://chromewebstore.googleapis.com';
const ITEM_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED']);
const UPLOAD_STATES = new Set(['SUCCEEDED', 'IN_PROGRESS', 'FAILED', 'NOT_FOUND']);
interface Revision {
  state: string;
  distributionChannels?: Array<{ crxVersion?: string }>;
}
interface ItemStatus {
  name?: string;
  itemId?: string;
  publishedItemRevisionStatus?: Revision;
  submittedItemRevisionStatus?: Revision;
  lastAsyncUploadState?: string;
  takenDown?: boolean;
}
interface UploadResponse { name?: string; itemId?: string; uploadState?: string; crxVersion?: string }
interface PublishResponse { name?: string; itemId?: string; state?: string }

export class ChromeWebStoreTarget extends DeployTarget {
  private token = '';

  constructor(private readonly extensionId: string, private readonly publisherId: string) {
    super('chrome', 'Chrome Web Store', `publishers/${publisherId}/items/${extensionId}`);
  }

  validate(): void {
    if (!this.extensionId) throw new DeployError('MISSING_INPUT', 'Missing input: chrome-extension-id');
    if (!this.publisherId) throw new DeployError('MISSING_INPUT', 'Missing input: chrome-publisher-id');
    if (![this.extensionId, this.publisherId].every((id) => /^[A-Za-z0-9_-]+$/.test(id))) {
      throw new DeployError('INVALID_INPUT', 'Chrome extension and publisher IDs must be single path identifiers.');
    }
    requireEnv('CHROME_SERVICE_ACCOUNT_KEY');
  }

  async execute(ctx: DeployContext): Promise<void> {
    this.token = await createGoogleAccessToken(requireEnv('CHROME_SERVICE_ACCOUNT_KEY'), undefined, ctx.options.requestTimeoutMs);
    ctx.result.phase = 'status';
    let status = await this.fetchStatus(ctx);
    if (ctx.options.operation === 'status') {
      const confirmed = await this.reconcileKnownRevision(ctx, status, ctx.receipt?.version);
      if (!confirmed && ctx.receipt?.upload?.state === 'pending') {
        await this.resolveAsyncUpload(ctx, status);
      } else if (!confirmed && ctx.receipt?.upload?.state === 'uncertain') {
        throw new DeployError('CHROME_UPLOAD_UNCONFIRMED', 'The previous upload response was lost. The latest asynchronous upload state cannot identify its ZIP. Check the Chrome dashboard before resuming.', 'blocked');
      }
      if (!confirmed && ['uncertain', 'pending'].includes(ctx.receipt?.publish?.state ?? '')) {
        throw new DeployError('CHROME_PUBLISH_UNCONFIRMED', 'The saved submission is not confirmed for this ZIP version. Check the Chrome dashboard before resuming.', 'blocked');
      }
      ctx.result.outcome = !confirmed && status.lastAsyncUploadState === 'IN_PROGRESS' ? 'pending' : 'success';
      const revision = status.submittedItemRevisionStatus ?? status.publishedItemRevisionStatus;
      const versions = new Set(revision?.distributionChannels?.map((channel) => channel.crxVersion));
      if (!ctx.receipt && versions.size === 1) ctx.result.version = [...versions][0];
      ctx.result.message = `Submitted: ${describeRevision(status.submittedItemRevisionStatus)}; published: ${describeRevision(status.publishedItemRevisionStatus)}; latest asynchronous upload: ${status.lastAsyncUploadState ?? 'unavailable'}.`;
      return;
    }
    if (!ctx.artifact) throw new DeployError('MISSING_ARTIFACT', 'Chrome writes require a ZIP artifact.');
    this.assertNoConflictingSubmission(status, ctx.artifact.version);
    if (await this.reconcileKnownRevision(ctx, status, ctx.artifact.version)) return;
    this.assertNoConflictingUpload(ctx, status);
    if (ctx.receipt?.publish && ctx.receipt.publish.state !== 'failed') {
      throw new DeployError('CHROME_PUBLISH_UNCONFIRMED', 'A previous submission cannot be confirmed for this ZIP version. Check the Chrome dashboard; no duplicate submission was sent.', 'blocked');
    }

    if (ctx.options.operation !== 'publish') {
      await this.upload(ctx, status);
      if (ctx.options.operation === 'upload') return;
      status = await this.fetchStatus(ctx);
      this.assertNoConflictingSubmission(status, ctx.artifact.version);
      if (await this.reconcileKnownRevision(ctx, status, ctx.artifact.version)) return;
      this.assertNoConflictingUpload(ctx, status);
    } else if (ctx.receipt?.upload?.state !== 'succeeded') {
      throw new DeployError('CHROME_UPLOAD_RECEIPT_REQUIRED', 'Publishing requires a successful upload record for the same item, version, and ZIP fingerprint. Chrome does not expose the current draft package identity.', 'blocked');
    }
    await this.publish(ctx);
  }

  private async fetchStatus(ctx: DeployContext): Promise<ItemStatus> {
    const status = await ctx.http.json<ItemStatus>(`${API_BASE}/v2/${this.itemId}:fetchStatus`, { headers: this.headers() });
    this.assertIdentity(status);
    for (const revision of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
      if (revision && (!ITEM_STATES.has(revision.state) ||
        (revision.distributionChannels !== undefined && (!Array.isArray(revision.distributionChannels) ||
          revision.distributionChannels.some((channel) => !channel || typeof channel.crxVersion !== 'string'))))) {
        throw new DeployError('CHROME_UNKNOWN_STATE', 'Chrome returned an unrecognized revision state or package version; no write was sent.', 'blocked');
      }
    }
    if (status.lastAsyncUploadState !== undefined && !UPLOAD_STATES.has(status.lastAsyncUploadState)) {
      throw new DeployError('CHROME_UNKNOWN_STATE', 'Chrome returned an unrecognized upload state; no write was sent.', 'blocked');
    }
    ctx.result.remoteState = status.submittedItemRevisionStatus?.state ?? status.publishedItemRevisionStatus?.state ?? 'DRAFT';
    if (status.takenDown) throw new DeployError('CHROME_TAKEN_DOWN', 'Chrome has taken down this item. Resolve it in the developer dashboard before deploying.', 'blocked');
    return status;
  }

  private assertIdentity(value: { name?: string; itemId?: string } | null): void {
    if (!value || (!value.name && !value.itemId) ||
      (value.name !== undefined && value.name !== this.itemId) ||
      (value.itemId !== undefined && value.itemId !== this.extensionId)) {
      throw new DeployError('CHROME_INVALID_RESPONSE', 'Chrome returned a missing or mismatched item identity.', 'blocked');
    }
  }

  private assertNoConflictingSubmission(status: ItemStatus, version: string): void {
    const submitted = status.submittedItemRevisionStatus;
    if (submitted && ['PENDING_REVIEW', 'STAGED'].includes(submitted.state) && !matchesVersion(submitted, version)) {
      throw new DeployError('CHROME_SUBMISSION_CONFLICT', 'Another or unidentified version is already under review or staged. This action will not cancel or replace it.', 'blocked');
    }
  }

  private assertNoConflictingUpload(ctx: DeployContext, status: ItemStatus): void {
    if (status.lastAsyncUploadState === 'IN_PROGRESS' && ctx.receipt?.upload?.state !== 'pending') {
      throw new DeployError('CHROME_UPLOAD_CONFLICT', 'Chrome is processing an upload without a matching acknowledged pending operation. No package upload or publication was sent.', 'blocked');
    }
  }

  private async reconcileKnownRevision(ctx: DeployContext, status: ItemStatus, version?: string): Promise<boolean> {
    if (!version) return false;
    const submitted = status.submittedItemRevisionStatus;
    const published = status.publishedItemRevisionStatus;
    const revision = submitted && ['PENDING_REVIEW', 'STAGED'].includes(submitted.state) && matchesVersion(submitted, version)
      ? submitted
      : published && ['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(published.state) && matchesVersion(published, version)
        ? published : undefined;
    if (!revision) {
      if (submitted && ['REJECTED', 'CANCELLED'].includes(submitted.state) && matchesVersion(submitted, version) && ctx.receipt?.publish) {
        await ctx.record('publish', { state: 'failed', message: `Chrome submission is ${submitted.state}.` });
        throw new DeployError('CHROME_SUBMISSION_FAILED', `Chrome submission is ${submitted.state}. Check the developer dashboard before submitting again.`, 'blocked');
      }
      return false;
    }
    // Version reuse requires immutable release artifacts; the local receipt also binds the ZIP hash.
    await ctx.record('upload', { state: 'succeeded', message: `Version ${version} is present in Chrome.` });
    await ctx.record('publish', { state: 'succeeded', message: revision.state });
    ctx.result.remoteState = revision.state;
    ctx.result.outcome = 'skipped';
    ctx.result.message = revision.state === 'PENDING_REVIEW'
      ? 'This version is already submitted for review; upload and submission were skipped.'
      : revision.state === 'STAGED'
        ? 'This version is already approved and staged; its existing publication choice was preserved.'
        : `This version is already ${revision.state}; upload and submission were skipped.`;
    return true;
  }

  private async upload(ctx: DeployContext, status: ItemStatus): Promise<void> {
    ctx.result.phase = 'upload';
    if (ctx.receipt?.upload?.state === 'succeeded') {
      ctx.result.outcome = 'skipped';
      ctx.result.message = 'Reused the successful upload record for this ZIP.';
      return;
    }
    if (ctx.receipt?.upload?.state === 'uncertain') {
      throw new DeployError('CHROME_UPLOAD_UNCONFIRMED', 'The previous upload response was lost. Chrome does not expose a draft version or ZIP fingerprint, so the saved upload cannot be safely repeated. Check the developer dashboard.', 'blocked');
    }
    if (ctx.receipt?.upload?.state === 'pending') {
      await this.waitForUpload(ctx);
      return;
    }
    if (status.lastAsyncUploadState === 'IN_PROGRESS') {
      throw new DeployError('CHROME_UPLOAD_CONFLICT', 'Chrome is processing an upload without a matching saved operation. Wait for it to finish before uploading.', 'blocked');
    }
    const artifact = ctx.artifact!;
    const body = new Uint8Array(await readArtifactBytes(artifact));
    await ctx.record('upload', { state: 'uncertain', message: 'Upload intent saved before sending the ZIP.' });
    let data: UploadResponse;
    try {
      data = await ctx.http.json<UploadResponse>(`${API_BASE}/upload/v2/${this.itemId}:upload`, {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/zip' }, body,
      });
      this.assertIdentity(data);
      if (data.uploadState !== 'SUCCEEDED' && data.uploadState !== 'IN_PROGRESS' && data.uploadState !== 'FAILED') {
        throw new DeployError('CHROME_UNKNOWN_STATE', 'Chrome returned an unrecognized upload result.', 'pending');
      }
      if (data.uploadState === 'SUCCEEDED' && data.crxVersion !== artifact.version) {
        throw new DeployError('CHROME_VERSION_MISMATCH', 'Chrome did not confirm the uploaded ZIP version.', 'pending');
      }
    } catch (error) {
      await this.handleWriteError(ctx, 'upload', error);
      return;
    }
    if (data.uploadState === 'FAILED') {
      await ctx.record('upload', { state: 'failed', message: 'Chrome rejected the package upload.' });
      throw new DeployError('CHROME_UPLOAD_FAILED', 'Chrome rejected the package upload. Check the developer dashboard.');
    }
    if (data.uploadState === 'IN_PROGRESS') {
      await ctx.record('upload', { state: 'pending', message: 'Chrome acknowledged this ZIP and is processing it.' });
      await this.waitForUpload(ctx);
    } else {
      await ctx.record('upload', { state: 'succeeded' });
      ctx.result.outcome = 'success';
      ctx.result.message = 'Package uploaded; it has not been submitted for review.';
    }
  }

  private async waitForUpload(ctx: DeployContext): Promise<void> {
    const status = await ctx.http.poll(() => this.fetchStatus(ctx), (value) => value.lastAsyncUploadState !== 'IN_PROGRESS');
    await this.resolveAsyncUpload(ctx, status);
  }

  private async resolveAsyncUpload(ctx: DeployContext, status: ItemStatus): Promise<void> {
    if (status.lastAsyncUploadState === 'SUCCEEDED') {
      await ctx.record('upload', { state: 'succeeded' });
      ctx.result.outcome = 'success';
      ctx.result.message = 'Package upload completed; it has not been submitted for review.';
    } else if (status.lastAsyncUploadState === 'FAILED') {
      await ctx.record('upload', { state: 'failed', message: 'Chrome package processing failed.' });
      throw new DeployError('CHROME_UPLOAD_FAILED', 'Chrome package processing failed. Check the developer dashboard.');
    } else if (status.lastAsyncUploadState === 'IN_PROGRESS') {
      ctx.result.outcome = 'pending';
      ctx.result.message = 'Chrome is still processing the acknowledged ZIP upload.';
    } else {
      throw new DeployError('CHROME_UPLOAD_UNCONFIRMED', 'Chrome no longer exposes the saved asynchronous upload state. Check the dashboard; the ZIP was not uploaded again.', 'blocked');
    }
  }

  private async publish(ctx: DeployContext): Promise<void> {
    ctx.result.phase = 'publish';
    await ctx.record('publish', { state: 'uncertain', message: 'Submission intent saved before sending the request.' });
    let data: PublishResponse;
    try {
      data = await ctx.http.json<PublishResponse>(`${API_BASE}/v2/${this.itemId}:publish`, {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
      });
      this.assertIdentity(data);
      if (!data.state || !ITEM_STATES.has(data.state)) {
        throw new DeployError('CHROME_UNKNOWN_STATE', 'Chrome returned an unrecognized submission result.', 'pending');
      }
    } catch (error) {
      await this.handleWriteError(ctx, 'publish', error);
      return;
    }
    ctx.result.remoteState = data.state;
    if (data.state === 'REJECTED' || data.state === 'CANCELLED') {
      await ctx.record('publish', { state: 'failed', message: data.state });
      throw new DeployError('CHROME_SUBMISSION_FAILED', `Chrome submission is ${data.state}.`);
    }
    await ctx.record('publish', { state: 'succeeded', message: data.state });
    ctx.result.outcome = 'success';
    ctx.result.message = data.state === 'PENDING_REVIEW'
      ? 'Submitted for Chrome review; the new version is not yet live.'
      : data.state === 'STAGED' ? 'Chrome approved and staged the version; it is not yet live.'
        : `Chrome publication state: ${data.state}.`;
  }

  private async handleWriteError(ctx: DeployContext, phase: 'upload' | 'publish', error: unknown): Promise<void> {
    if (error instanceof HttpError && !error.uncertain) {
      await ctx.record(phase, { state: 'failed', message: `Chrome rejected the request (${error.status}).` });
      throw error;
    }
    // A lost response is not a failed write. Reconcile by version before considering any retry.
    try {
      const status = await this.fetchStatus(ctx);
      if (await this.reconcileKnownRevision(ctx, status, ctx.artifact?.version)) return;
    } catch {
      // Preserve the saved uncertain intent even if the readback also fails.
    }
    throw new DeployError('CHROME_WRITE_UNCONFIRMED', `Chrome ${phase} may have been accepted, but its result cannot be verified for this ZIP. No write was retried; inspect the dashboard and saved deployment record.`, 'blocked');
  }

  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` }; }
}

function matchesVersion(revision: Revision, version: string): boolean {
  return !!revision.distributionChannels?.length && revision.distributionChannels.every((channel) => channel.crxVersion === version);
}

function describeRevision(revision?: Revision): string {
  if (!revision) return 'none';
  return `${revision.state} (${revision.distributionChannels?.map((channel) => channel.crxVersion).join(', ') || 'version unavailable'})`;
}
