import type { ConfigEditPayload, ConfigJobKind } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import { parseConfigEditPayload } from '../executor/config-job/payload';
import type { Logger } from '../logger';
import { ServerError } from '../sync/http';
import type { Sleep } from '../time';

/** Built in daemon.ts over `ServerClient.getConfigEdit`; rejects with ServerError / NetworkError. */
export interface ConfigEditSource {
  fetch(jobId: string, leaseEpoch: number): Promise<unknown>;
}

export type ConfigEditFetch = { kind: 'ok'; payload: ConfigEditPayload } | { kind: 'stale' } | { kind: 'failed'; reason: string };

/** Same shape as the PLAN push back-off (D77): three attempts in all. */
export const CONFIG_FETCH_BACKOFF_MS: readonly number[] = [2_000, 8_000];

export interface FetchConfigEditInput {
  readonly source: ConfigEditSource | undefined;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly command: ConfigJobKind;
  readonly sleep: Sleep;
  /** An ABANDON (halt) during the back-off: stop and report nothing. */
  readonly isHalted: () => boolean;
  readonly log: Logger;
}

/** S3 §3, D478: a 409 is the lease fence (ABANDON follows); another 4xx is final; anything else is retried. */
export async function fetchConfigEdit(input: FetchConfigEditInput): Promise<ConfigEditFetch> {
  if (!input.source) return { kind: 'failed', reason: 'config jobs are not wired in this runner' };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = parseConfigEditPayload(await input.source.fetch(input.jobId, input.leaseEpoch), input.command);
      return payload ? { kind: 'ok', payload } : { kind: 'failed', reason: 'invalid config edit payload' };
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) return { kind: 'stale' };
      if (error instanceof ServerError && error.status >= 400 && error.status < 500) return { kind: 'failed', reason: `config edit fetch refused (${error.status})` };
      input.log.warn('config edit fetch failed', { jobId: input.jobId, attempt, error: errorMessage(error) });
    }
    const backoff = CONFIG_FETCH_BACKOFF_MS[attempt];
    if (backoff === undefined) return { kind: 'failed', reason: 'config edit fetch failed' };
    if (input.isHalted()) return { kind: 'stale' };
    await input.sleep(backoff);
    if (input.isHalted()) return { kind: 'stale' };
  }
}
