import { setTimeout as delay } from 'node:timers/promises';
import { DeployError, type ActionInputs } from './types.js';

export class HttpError extends DeployError {
  constructor(readonly status: number, message: string, readonly uncertain = false) {
    super(`HTTP_${status}`, message, status === 409 ? 'blocked' : uncertain ? 'pending' : 'failed');
  }
}
export type HttpOptions = Pick<ActionInputs, 'requestTimeoutMs' | 'pollTimeoutMs' | 'pollIntervalMs' | 'maxAttempts'>;

export class HttpClient {
  private pollDeadline?: number;
  constructor(readonly options: HttpOptions) {}

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const readOnly = (init.method ?? 'GET').toUpperCase() === 'GET';
    const attempts = readOnly ? this.options.maxAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.requestTimeout()), redirect: 'error' });
      } catch {
        this.checkDeadline();
        if (readOnly && attempt < attempts) {
          await this.pause(this.backoff(attempt));
          continue;
        }
        throw new DeployError('REQUEST_UNCERTAIN', `${readOnly ? 'Status request' : 'Write request'} timed out or failed. ${readOnly ? 'Retry the status check.' : 'The store may have accepted it; inspect or resume the saved operation before sending another write.'}`, readOnly ? 'failed' : 'pending');
      }
      if (res.ok) return res;
      const transient = res.status === 429 || res.status >= 500;
      const text = (await res.text().catch(() => '')).slice(0, 2000);
      this.checkDeadline();
      if (readOnly && transient && attempt < attempts) {
        const after = res.headers.get('retry-after');
        const seconds = after === null ? NaN : Number(after);
        const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : after ? Date.parse(after) - Date.now() : NaN;
        await this.pause(Number.isFinite(milliseconds) ? Math.min(60000, Math.max(0, milliseconds)) : this.backoff(attempt));
        continue;
      }
      const advice = res.status === 401 || res.status === 403 ? ' Check the store credentials and account permissions; authentication errors are not retried.' : '';
      throw new HttpError(res.status, `Store request failed (${res.status}).${advice}${text ? ` ${text}` : ''}`, !readOnly && res.status >= 500);
    }
    throw new DeployError('REQUEST_FAILED', 'Request attempts exhausted.');
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    try {
      return await response.json() as T;
    } catch {
      this.checkDeadline();
      const readOnly = (init.method ?? 'GET').toUpperCase() === 'GET';
      throw new DeployError('INVALID_RESPONSE', 'Store returned an invalid JSON response. Check its current state before retrying a write.', readOnly ? 'failed' : 'pending');
    }
  }

  async poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const previousDeadline = this.pollDeadline;
    this.pollDeadline = Date.now() + this.options.pollTimeoutMs;
    try {
      for (;;) {
        this.checkDeadline();
        const value = await read();
        if (done(value)) return value;
        await this.pause(this.options.pollIntervalMs);
      }
    } finally {
      this.pollDeadline = previousDeadline;
    }
  }

  private checkDeadline(): void {
    if (this.pollDeadline !== undefined && Date.now() >= this.pollDeadline) {
      throw new DeployError('POLL_TIMEOUT', 'Store processing is still pending. Resume from the saved operation instead of uploading again.', 'pending');
    }
  }

  private requestTimeout(): number {
    this.checkDeadline();
    return this.pollDeadline === undefined ? this.options.requestTimeoutMs
      : Math.max(1, Math.min(this.options.requestTimeoutMs, this.pollDeadline - Date.now()));
  }

  private async pause(milliseconds: number): Promise<void> {
    this.checkDeadline();
    const remaining = this.pollDeadline === undefined ? milliseconds : Math.max(0, this.pollDeadline - Date.now());
    await delay(Math.min(milliseconds, remaining));
    this.checkDeadline();
  }

  private backoff(attempt: number): number {
    return Math.min(10000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
  }
}
