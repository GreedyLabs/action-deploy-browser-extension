import { HttpClient } from '../http.js';
import type { GitHubApi, RunContext, StoredArtifact, WorkflowJob, WorkflowRun } from './types.js';

/** GitHub read operations used by the reusable workflow; store credentials never enter this client. */
export class RepositoryApi implements GitHubApi {
  private readonly http = new HttpClient({ requestTimeoutMs: 30000, pollTimeoutMs: 300000, pollIntervalMs: 5000, maxAttempts: 3 });
  private readonly root: string;

  constructor(private readonly token: string, context: RunContext, apiUrl = 'https://api.github.com') {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('GITHUB_API_URL must be an HTTPS API URL.');
    this.root = `${apiUrl.replace(/\/$/, '')}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}`;
  }

  async getRun(runId: number): Promise<WorkflowRun> {
    const run = await this.get<WorkflowRun>(`/actions/runs/${runId}`);
    if (!run || run.id !== runId || !Number.isSafeInteger(run.workflow_id) || !Number.isSafeInteger(run.run_attempt) ||
      typeof run.head_sha !== 'string' || typeof run.status !== 'string') throw new Error('GitHub returned an invalid workflow run.');
    return run;
  }

  async listRuns(workflowId: number, sha: string, branch?: string): Promise<WorkflowRun[]> {
    const params = new URLSearchParams({ head_sha: sha, event: 'push' });
    if (branch) params.set('branch', branch);
    return this.collection<WorkflowRun>(`/actions/workflows/${workflowId}/runs?${params}`, 'workflow_runs', 1000);
  }

  async listArtifacts(runId: number): Promise<StoredArtifact[]> {
    return this.collection<StoredArtifact>(`/actions/runs/${runId}/artifacts`, 'artifacts');
  }

  async listJobs(runId: number, attempt: number): Promise<WorkflowJob[]> {
    return this.collection<WorkflowJob>(`/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs');
  }

  async getBranchHead(branch: string): Promise<string> {
    const data = await this.get<{ commit?: { sha?: unknown } }>(`/branches/${encodeURIComponent(branch)}`);
    if (typeof data?.commit?.sha !== 'string') throw new Error('GitHub returned no branch commit.');
    return data.commit.sha;
  }

  private async collection<T>(endpoint: string, key: string, maximum = 10000): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= Math.ceil(maximum / 100); page += 1) {
      const data = await this.get<Record<string, unknown>>(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!data || !Array.isArray(data[key])) throw new Error(`GitHub returned an invalid ${key} collection.`);
      if (typeof data.total_count === 'number' && data.total_count > maximum) throw new Error('The deployment history is too large to inspect safely. Specify an original source-run-id or archive obsolete workflow history.');
      const items = data[key] as T[];
      values.push(...items);
      if (items.length < 100 || (typeof data.total_count === 'number' && values.length >= data.total_count)) return values;
    }
    throw new Error('Deployment history pagination exceeded its safe limit.');
  }

  private async get<T>(endpoint: string): Promise<T> {
    return this.http.json<T>(`${this.root}${endpoint}`, { headers: {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    } });
  }
}
