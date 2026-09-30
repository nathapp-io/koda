export interface Tuning {
  readonly statusPollMs: number;
  readonly killGraceMs: number;
  readonly syncMinGapMs: number;
  readonly syncTimeoutMs: number;
  readonly capacityRefreshMs: number;
  readonly pruneIntervalMs: number;
  readonly readoptHeartbeatMs: number;
  /** D60: how often and for how long a job waits for the server to ack its UPLOADING event before it uploads the bundle. */
  readonly ackPollMs: number;
  readonly uploadAckWaitMs: number;
}

/** D42: the design's constants in one place; only `startDaemon` options (tests) override them, runner.json cannot. */
export const TUNING: Tuning = Object.freeze({
  statusPollMs: 2_000,
  killGraceMs: 30_000,
  syncMinGapMs: 250,
  syncTimeoutMs: 35_000,
  capacityRefreshMs: 300_000,
  pruneIntervalMs: 86_400_000,
  readoptHeartbeatMs: 120_000,
  ackPollMs: 250,
  uploadAckWaitMs: 60_000,
});
