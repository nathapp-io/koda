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
});
