import type { EnrollRequest, EnrollResponse, RunnerIdentity, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class ServerError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = 'ServerError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ServerClientOptions {
  readonly serverUrl: string;
  readonly apiKey?: string;
  readonly fetchFn?: FetchFn;
  readonly syncTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

function messageOf(body: unknown): string | null {
  return typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;
}

export class ServerClient {
  constructor(private readonly options: ServerClientOptions) {}

  private url(path: string): string {
    return `${this.options.serverUrl}/api${path}`;
  }

  private bearer(): Record<string, string> {
    if (!this.options.apiKey) throw new Error('runner api key is not set');
    return { authorization: `Bearer ${this.options.apiKey}` };
  }

  private async send(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await (this.options.fetchFn ?? fetch)(url, { ...init, signal: merged });
    } catch (error) {
      if (isAbort(error) || merged.aborted) throw merged.reason instanceof Error ? merged.reason : error;
      throw new NetworkError(errorMessage(error));
    }
  }

  private async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new ServerError(response.status, messageOf(body) ?? response.statusText, body);
    const envelope = body as { ret?: unknown; data?: unknown } | null;
    if (envelope === null || typeof envelope !== 'object' || envelope.ret !== 0) {
      throw new ServerError(response.status, messageOf(body) ?? 'unexpected response shape', body);
    }
    return envelope.data as T;
  }

  /** async on purpose: a missing api key (`bearer()` throws) must surface as a rejection, not a synchronous throw. */
  private async post<T>(path: string, body: unknown, auth: boolean, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(auth ? this.bearer() : {}) };
    const response = await this.send(this.url(path), { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, signal);
    return this.json<T>(response);
  }

  enroll(body: EnrollRequest): Promise<EnrollResponse> {
    return this.post('/fleet/runner/enroll', body, false, this.options.requestTimeoutMs ?? 15_000);
  }

  async me(signal?: AbortSignal): Promise<RunnerIdentity> {
    const response = await this.send(this.url('/fleet/runner/me'), { method: 'GET', headers: this.bearer() }, this.options.requestTimeoutMs ?? 15_000, signal);
    return this.json<RunnerIdentity>(response);
  }

  sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> {
    return this.post('/fleet/runner/sync', request, true, this.options.syncTimeoutMs ?? 35_000, signal);
  }

  async uploadBundle(args: { jobId: string; leaseEpoch: number; filePath: string; sha256: string; signal?: AbortSignal }): Promise<{ status: number }> {
    const url = `${this.url(`/fleet/runner/jobs/${encodeURIComponent(args.jobId)}/bundle`)}?leaseEpoch=${args.leaseEpoch}`;
    const headers = { ...this.bearer(), 'content-type': 'application/gzip', 'x-content-sha256': args.sha256 };
    const response = await this.send(url, { method: 'PUT', headers, body: Bun.file(args.filePath) }, UPLOAD_TIMEOUT_MS, args.signal);
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  }
}
