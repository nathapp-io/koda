import { describe, expect, test } from 'bun:test';
import { TUNING } from './tuning';

describe('TUNING (D42, slice 3 design)', () => {
  test('carries the design constants', () => {
    expect(TUNING).toEqual({
      statusPollMs: 2_000, killGraceMs: 30_000, syncMinGapMs: 250, syncTimeoutMs: 35_000,
      capacityRefreshMs: 300_000, pruneIntervalMs: 86_400_000, readoptHeartbeatMs: 120_000,
      ackPollMs: 250, uploadAckWaitMs: 60_000,
      tokenRefreshMarginMs: 240_000, tokenCooldownMs: 30_000, tokenWaitMs: 120_000, tokenServeWaitMs: 30_000, tokenPollMs: 250,
      capabilityProbeMs: 600_000, naxCallTimeoutMs: 30_000, jobCheckTimeoutMs: 10_000,
      logChunkBytes: 1_048_576, logMaxInFlight: 2, logPutTimeoutMs: 30_000, logBackoffMaxMs: 30_000, logDrainTimeoutMs: 120_000,
    });
    expect(Object.isFrozen(TUNING)).toBe(true);
  });
});
