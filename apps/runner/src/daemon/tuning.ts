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
  /** D92, design §3.1: ask for a new git token this long before the current one expires. */
  readonly tokenRefreshMarginMs: number;
  /** D81: pause after a token already inside the refresh margin, or a token error. */
  readonly tokenCooldownMs: number;
  /** D82: how long prepare waits for a job's first token. */
  readonly tokenWaitMs: number;
  /** D79: how long the socket holds a request open for a token that has not arrived. */
  readonly tokenServeWaitMs: number;
  readonly tokenPollMs: number;
  /** D102, design §3.2: how often the capability probe runs (it also runs at start and on SIGHUP). */
  readonly capabilityProbeMs: number;
  /** D96: the timeout of one nax call. */
  readonly naxCallTimeoutMs: number;
  /** D111: the timeout of one nax call in the post-checkout job check, which holds the per-repo mutex. */
  readonly jobCheckTimeoutMs: number;
  /** S2a §7: the largest log window one PUT carries. */
  readonly logChunkBytes: number;
  /** S2a R4: log PUTs in flight at once, across every job of the runner. */
  readonly logMaxInFlight: number;
  /** S2a R4: a log PUT is aborted after this long. */
  readonly logPutTimeoutMs: number;
  /** S2a §2.4: the ceiling of the log upload backoff. */
  readonly logBackoffMaxMs: number;
  /** S2a R5: how long a finished job waits for its logs before UPLOADING. */
  readonly logDrainTimeoutMs: number;
  /** S3 §5 lifecycle, D483: a config job's hard timeout. */
  readonly configJobTimeoutMs: number;
  /** S3 §3, D483: the RUNNING config job's heartbeat snapshot interval. */
  readonly configHeartbeatMs: number;
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
  tokenRefreshMarginMs: 240_000,
  tokenCooldownMs: 30_000,
  tokenWaitMs: 120_000,
  tokenServeWaitMs: 30_000,
  tokenPollMs: 250,
  capabilityProbeMs: 600_000,
  naxCallTimeoutMs: 30_000,
  jobCheckTimeoutMs: 10_000,
  logChunkBytes: 1_048_576,
  logMaxInFlight: 2,
  logPutTimeoutMs: 30_000,
  logBackoffMaxMs: 30_000,
  logDrainTimeoutMs: 120_000,
  configJobTimeoutMs: 600_000,
  configHeartbeatMs: 30_000,
});
