import { RunnerByteRate } from './runner-byte-rate';

describe('RunnerByteRate', () => {
  const rate = () => new RunnerByteRate({ bytesPerSec: 1000, burstBytes: 1000 });

  it('lets a full burst through, then refuses with the wait for the deficit', () => {
    const r = rate();
    expect(r.take('a', 1000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('a', 500, 0)).toEqual({ ok: 'no', retryAfterMs: 500 });
    expect(r.take('a', 500, 500)).toEqual({ ok: 'yes' });
  });

  it('keeps one bucket per runner', () => {
    const r = rate();
    expect(r.take('a', 1000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('b', 1000, 0)).toEqual({ ok: 'yes' });
  });

  it('reuses the bucket map and evicts idle runners after their buckets refill', () => {
    const r = rate();
    const buckets = r['buckets'];
    r.take('idle', 1000, 0);
    r.take('busy', 1000, 0);

    expect(r.take('busy', 700, 500)).toEqual({ ok: 'no', retryAfterMs: 200 });
    expect(r['buckets']).toBe(buckets);
    expect(buckets.has('idle')).toBe(true);
    expect(r.take('busy', 300, 500)).toEqual({ ok: 'yes' });

    r.take('new-a', 1000, 1000);
    r.take('new-b', 1000, 1000);
    expect(buckets.has('idle')).toBe(false);
    expect(r.take('busy', 1000, 1000)).toEqual({ ok: 'no', retryAfterMs: 300 });
    expect(r.take('idle', 1000, 1000)).toEqual({ ok: 'yes' });
  });

  it('charges at most the burst for one request (a larger declared length waits for a full bucket)', () => {
    const r = rate();
    expect(r.take('a', 5000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('a', 1000, 100)).toEqual({ ok: 'no', retryAfterMs: 900 });
  });
});
