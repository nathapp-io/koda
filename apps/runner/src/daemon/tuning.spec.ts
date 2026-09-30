import { describe, expect, test } from 'bun:test';
import { TUNING } from './tuning';

describe('TUNING (D42, slice 3 design)', () => {
  test('carries the design constants', () => {
    expect(TUNING).toEqual({
      statusPollMs: 2_000, killGraceMs: 30_000, syncMinGapMs: 250, syncTimeoutMs: 35_000,
      capacityRefreshMs: 300_000, pruneIntervalMs: 86_400_000, readoptHeartbeatMs: 120_000,
      ackPollMs: 250, uploadAckWaitMs: 60_000,
    });
    expect(Object.isFrozen(TUNING)).toBe(true);
  });
});
