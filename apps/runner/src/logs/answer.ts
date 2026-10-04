import type { PutLogAnswer } from './types';

export type AnswerAction =
  | { readonly kind: 'ack'; readonly size: number }
  | { readonly kind: 'done'; readonly size: number }
  | { readonly kind: 'cap'; readonly size: number }
  | { readonly kind: 'pause'; readonly ms: number }
  | { readonly kind: 'stop-job'; readonly status: number }
  | { readonly kind: 'fail-stream'; readonly status: number }
  | { readonly kind: 'backoff'; readonly detail: string };

const DEFAULT_PAUSE_MS = 1_000;
/** Final review: a buggy or hostile retryAfterMs must not freeze every job's logs. */
const MAX_PAUSE_MS = 60_000;

/** Spec §2.4 response table, extended by plan D323. Pure: the shipper applies the action. */
export function classifyAnswer(answer: PutLogAnswer): AnswerAction {
  const { status } = answer;
  if (status >= 200 && status < 300) {
    const { outcome, size } = answer;
    if (outcome === undefined || size === undefined || !Number.isSafeInteger(size)) return { kind: 'backoff', detail: 'malformed 2xx answer' };
    if (outcome !== 'rate_limited' && size < 0) return { kind: 'backoff', detail: 'malformed 2xx answer' };
    switch (outcome) {
      case 'appended':
      case 'duplicate':
      case 'offset':
        return { kind: 'ack', size };
      case 'complete':
        return { kind: 'done', size };
      case 'stream_cap':
        return { kind: 'cap', size };
      case 'rate_limited':
        return { kind: 'pause', ms: answer.retryAfterMs !== undefined && answer.retryAfterMs > 0 ? Math.min(answer.retryAfterMs, MAX_PAUSE_MS) : DEFAULT_PAUSE_MS };
      default:
        return { kind: 'backoff', detail: 'malformed 2xx answer' };
    }
  }
  if (status === 401 || status === 404 || status === 409) return { kind: 'stop-job', status };
  if (status === 408 || status === 422 || status === 429 || status >= 500) return { kind: 'backoff', detail: `HTTP ${status}` };
  return { kind: 'fail-stream', status };
}
