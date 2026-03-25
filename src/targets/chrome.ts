import { setOutput } from '@actions/core';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DeployTarget } from '../deploy.js';
import { requireEnv, base64url } from '../utils.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/upload/chromewebstore/v1.1';
const PUBLISH_BASE = 'https://www.googleapis.com/chromewebstore/v1.1';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface TokenResponse {
  access_token?: string;
}

interface UploadResponse {
  uploadState: string;
  itemError?: unknown[];
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

  async upload(zipPath: string): Promise<void> {
    this.log('Obtaining access token...');
    this.token = await this.getAccessToken();
    this.log('Access token obtained');

    const res = await fetch(`${API_BASE}/items/${this.extensionId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'x-goog-api-version': '2',
      },
      body: fs.readFileSync(zipPath),
    });

    const data = await res.json() as UploadResponse;
    setOutput('chrome-upload-status', data.uploadState);

    if (data.uploadState !== 'SUCCESS') {
      throw new Error(`Upload failed: ${JSON.stringify(data)}`);
    }
    this.log(`Upload status: ${data.uploadState}`);
  }

  async publish(): Promise<void> {
    const res = await fetch(`${PUBLISH_BASE}/items/${this.extensionId}/publish`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'x-goog-api-version': '2',
        'Content-Length': '0',
      },
    });

    if (!res.ok) {
      const data = await res.json() as unknown;
      throw new Error(`Publish failed (${res.status}): ${JSON.stringify(data)}`);
    }

    const data = await res.json() as PublishResponse;
    setOutput('chrome-publish-status', JSON.stringify(data.status));
    this.log(`Publish status: ${JSON.stringify(data.status)}`);
  }

  private async getAccessToken(): Promise<string> {
    const raw = requireEnv('CHROME_SERVICE_ACCOUNT_KEY').trim();
    const key = JSON.parse(raw) as ServiceAccountKey;
    const now = Math.floor(Date.now() / 1000);

    const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = base64url(Buffer.from(JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })));

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = base64url(sign.sign(key.private_key));

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${payload}.${signature}`,
      }),
    });

    const data = await res.json() as TokenResponse;
    if (!data.access_token) {
      throw new Error(`Failed to obtain access token: ${JSON.stringify(data)}`);
    }
    return data.access_token;
  }
}
