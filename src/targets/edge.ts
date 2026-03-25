import { setOutput } from '@actions/core';
import fs from 'node:fs';
import { DeployTarget } from '../deploy.js';
import { requireEnv } from '../utils.js';

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

  async upload(zipPath: string): Promise<void> {
    const res = await fetch(`${API_BASE}/${this.productId}/submissions/draft/package`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/zip',
      },
      body: fs.readFileSync(zipPath),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Upload failed (${res.status}): ${body}`);
    }

    const operationId = res.headers.get('Location');
    setOutput('edge-operation-id', operationId ?? '');
    this.log(`Upload status: accepted (operation: ${operationId})`);
  }

  async publish(): Promise<void> {
    const res = await fetch(`${API_BASE}/${this.productId}/submissions`, {
      method: 'POST',
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Publish failed (${res.status}): ${body}`);
    }

    this.log(`Publish status: ${res.status} ${res.statusText}`);
  }

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': `ApiKey ${requireEnv('EDGE_API_KEY')}`,
      'X-ClientID': requireEnv('EDGE_CLIENT_ID'),
    };
  }
}
