interface Bucket {
  readonly tokens: number;
  readonly atMs: number;
}

/** Spec §2.2.1, plan D312: per-runner token bucket, in-process. */
export class RunnerByteRate {
  private buckets: ReadonlyMap<string, Bucket> = new Map();

  constructor(private readonly opts: { bytesPerSec: number; burstBytes: number }) {}

  take(runnerId: string, bytes: number, nowMs: number): { ok: 'yes' } | { ok: 'no'; retryAfterMs: number } {
    const { bytesPerSec, burstBytes } = this.opts;
    const charge = Math.min(Math.max(bytes, 0), burstBytes);
    const previous = this.buckets.get(runnerId) ?? { tokens: burstBytes, atMs: nowMs };
    const tokens = Math.min(burstBytes, previous.tokens + ((nowMs - previous.atMs) * bytesPerSec) / 1000);
    if (tokens < charge) {
      this.buckets = new Map([...this.buckets, [runnerId, { tokens, atMs: nowMs }]]);
      return { ok: 'no', retryAfterMs: Math.ceil(((charge - tokens) * 1000) / bytesPerSec) };
    }
    this.buckets = new Map([...this.buckets, [runnerId, { tokens: tokens - charge, atMs: nowMs }]]);
    return { ok: 'yes' };
  }
}
