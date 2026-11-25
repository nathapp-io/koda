interface Bucket {
  tokens: number;
  atMs: number;
}

/** Spec §2.2.1, plan D312: per-runner token bucket, in-process. */
export class RunnerByteRate {
  private readonly buckets = new Map<string, Bucket>();
  private sweep = this.buckets.entries();
  private sweepRemaining = 0;

  constructor(private readonly opts: { bytesPerSec: number; burstBytes: number }) {}

  take(runnerId: string, bytes: number, nowMs: number): { ok: 'yes' } | { ok: 'no'; retryAfterMs: number } {
    this.evictOneIdleBucket(nowMs);

    const { bytesPerSec, burstBytes } = this.opts;
    const charge = Math.min(Math.max(bytes, 0), burstBytes);
    let bucket = this.buckets.get(runnerId);
    if (!bucket) {
      bucket = { tokens: burstBytes, atMs: nowMs };
      this.buckets.set(runnerId, bucket);
    }
    const tokens = this.refilledTokens(bucket, nowMs);
    bucket.tokens = tokens;
    bucket.atMs = nowMs;
    if (tokens < charge) {
      return { ok: 'no', retryAfterMs: Math.ceil(((charge - tokens) * 1000) / bytesPerSec) };
    }
    bucket.tokens -= charge;
    return { ok: 'yes' };
  }

  private refilledTokens(bucket: Bucket, nowMs: number): number {
    const { bytesPerSec, burstBytes } = this.opts;
    return Math.min(burstBytes, bucket.tokens + ((nowMs - bucket.atMs) * bytesPerSec) / 1000);
  }

  private evictOneIdleBucket(nowMs: number): void {
    // Bound each request to one check. End each pass at its original size so
    // concurrent arrivals cannot keep the iterator from revisiting old entries.
    if (this.sweepRemaining === 0) {
      this.sweep = this.buckets.entries();
      this.sweepRemaining = this.buckets.size;
    }
    if (this.sweepRemaining === 0) return;

    this.sweepRemaining--;
    const entry = this.sweep.next().value;
    if (!entry) return;
    const [runnerId, bucket] = entry;
    if (nowMs >= bucket.atMs && this.refilledTokens(bucket, nowMs) === this.opts.burstBytes) {
      this.buckets.delete(runnerId);
    }
  }
}
