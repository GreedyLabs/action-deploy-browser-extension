import { setOutput } from '@actions/core';
import fs from 'node:fs';
import { DeployTarget } from './base.js';
import { requireEnv } from '../env.js';

const API_BASE = 'https://api.addons.microsoftedge.microsoft.com/v1/products';

export class EdgeAddonsTarget extends DeployTarget {
  constructor(private readonly productId: string) {
    super('Microsoft Edge Add-ons');
  }

  validate(): void {
    if (!this.productId) throw new Error('Missing input: edge-product-id');
    requireEnv('EDGE_CLIENT_ID');
    requireEnv('EDGE_API_KEY');
  }

  async upload(zipPath: string): Promise<string> {
    const res = await fetch(`${API_BASE}/${this.productId}/submissions/draft/package`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/zip' },
      body: fs.readFileSync(zipPath),
    });

    if (!res.ok) {
      throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
    }

    const operationId = res.headers.get('Location') ?? '';
    setOutput('edge-operation-id', operationId);
    const status = `accepted (operation: ${operationId})`;
    this.log(`Upload status: ${status}`);
    return status;
  }

  async publish(): Promise<string> {
    const res = await fetch(`${API_BASE}/${this.productId}/submissions`, {
      method: 'POST',
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Publish failed (${res.status}): ${await res.text()}`);
    }

    const status = `${res.status} ${res.statusText}`;
    this.log(`Publish status: ${status}`);
    return status;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `ApiKey ${requireEnv('EDGE_API_KEY')}`,
      'X-ClientID': requireEnv('EDGE_CLIENT_ID'),
    };
  }
}
