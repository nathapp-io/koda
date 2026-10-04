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

  it('charges at most the burst for one request (a larger declared length waits for a full bucket)', () => {
    const r = rate();
    expect(r.take('a', 5000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('a', 1000, 100)).toEqual({ ok: 'no', retryAfterMs: 900 });
  });
});
