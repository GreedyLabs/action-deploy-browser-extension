import { setOutput } from '@actions/core';
import fs from 'node:fs';
import { DeployTarget } from './base.js';
import { requireEnv } from '../env.js';
import { createGoogleAccessToken } from '../google-auth.js';

const API_BASE = 'https://www.googleapis.com/upload/chromewebstore/v1.1';
const PUBLISH_BASE = 'https://www.googleapis.com/chromewebstore/v1.1';
const API_HEADERS = { 'x-goog-api-version': '2' };

interface UploadResponse {
  uploadState: string;
  itemError?: Array<{ error_code?: string; error_detail?: string }>;
}

interface PublishResponse {
  status: string[];
}

export class ChromeWebStoreTarget extends DeployTarget {
  private token = '';

  constructor(private readonly extensionId: string) {
    super('Chrome Web Store');
  }

  validate(): void {
    if (!this.extensionId) throw new Error('Missing input: chrome-extension-id');
    requireEnv('CHROME_SERVICE_ACCOUNT_KEY');
  }

  async upload(zipPath: string): Promise<string> {
    this.log('Obtaining access token...');
    this.token = await createGoogleAccessToken(requireEnv('CHROME_SERVICE_ACCOUNT_KEY'));
    this.log('Access token obtained');

    const res = await fetch(`${API_BASE}/items/${this.extensionId}`, {
      method: 'PUT',
      headers: { ...this.authHeaders(), ...API_HEADERS },
      body: fs.readFileSync(zipPath),
    });

    const data = await res.json() as UploadResponse;
    setOutput('chrome-upload-status', data.uploadState);

    if (data.uploadState !== 'SUCCESS') {
      throw new Error(`Upload failed (${data.uploadState}): ${formatItemErrors(data)}`);
    }
    this.log(`Upload status: ${data.uploadState}`);
    return data.uploadState;
  }

  async publish(): Promise<string> {
    const res = await fetch(`${PUBLISH_BASE}/items/${this.extensionId}/publish`, {
      method: 'POST',
      headers: { ...this.authHeaders(), ...API_HEADERS, 'Content-Length': '0' },
    });

    if (!res.ok) {
      const data = await res.json() as unknown;
      throw new Error(`Publish failed (${res.status}): ${JSON.stringify(data)}`);
    }

    const data = await res.json() as PublishResponse;
    const status = JSON.stringify(data.status);
    setOutput('chrome-publish-status', status);
    this.log(`Publish status: ${status}`);
    return status;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }
}

/** Renders the Chrome Web Store `itemError` array (manifest/package validation) readably. */
function formatItemErrors(data: UploadResponse): string {
  if (!data.itemError?.length) return JSON.stringify(data);
  return data.itemError
    .map((e) => `${e.error_code ?? 'ERROR'}: ${e.error_detail ?? ''}`.trim())
    .join('; ');
}
