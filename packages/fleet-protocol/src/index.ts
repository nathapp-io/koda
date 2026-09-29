/**
 * Koda fleet protocol (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md).
 * Shared by apps/api (type-only) and apps/runner. Bump FLEET_PROTOCOL_VERSION on any
 * incompatible wire change.
 */
export const FLEET_PROTOCOL_VERSION = 1 as const;

export type RunnerOs = 'darwin' | 'linux';
export type RunnerArch = 'arm64' | 'x64';
export type NaxProtocol = 'acp' | 'native';
export type RunnerExecutor = 'host';

export interface ProfileNeeds {
  protocol: NaxProtocol;
  providers: string[];
  sandbox: boolean;
}

/**
 * Validated by the server (#161): `nax.protocols` non-empty and unique; at most 64 profiles
 * named /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, each with at most 16 providers; at most 64
 * credentials; `expires` must parse as a date. Whole report at most 64 KiB.
 */
export interface RunnerCapabilities {
  nax: { version: string; protocols: NaxProtocol[] };
  sandbox: { available: boolean; probedAt: string; error?: string };
  profiles: Record<string, ProfileNeeds>;
  credentials: Array<{ providerId: string; kind: string; expires?: string }>;
  tools: { git: boolean; gh: boolean; glab: boolean };
  executors: RunnerExecutor[];
}

export interface EnrollRequest {
  enrollmentToken: string;
  name: string;
  os: RunnerOs;
  arch: RunnerArch;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  labels: string[];
  capabilities: RunnerCapabilities;
}

export interface EnrollResponse {
  runnerId: string;
  apiKey: string;
}

export interface RunnerIdentity {
  id: string;
  name: string;
  labels: string[];
  capacity: number;
  enabled: boolean;
}

// ---- Slice 2: jobs and sync (spec §3.2, §5) ----

export type FleetJobStateName =
  | 'QUEUED' | 'ASSIGNED' | 'RUNNING' | 'UPLOADING'
  | 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CRASHED' | 'CANCELLED';
export type FleetJobKindName = 'RUN' | 'PLAN';
export type FleetCommandTypeName = 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON';
export type RunnerEventType = 'state' | 'snapshot' | 'lifecycle' | 'log';

/** A runner-reported transition (§5.4 runner-owned rows only). */
export interface StateEventPayload { to: FleetJobStateName; reason?: string; exitCode?: number }

/** Mirror of nax status.json (§5.2 step 5). Every field optional; absent = unchanged. */
export interface SnapshotEventPayload {
  naxRunId?: string;
  naxLogRunId?: string;
  naxCostRunId?: string;
  progress?: Record<string, unknown>;
  currentStoryId?: string | null;
  currentPhase?: string | null;
  /** Decimal string, at most 4 fraction digits, e.g. "1.2345". */
  costSpentUsd?: string;
  heartbeatAt?: string;
  finishResult?: string;
  escalationReason?: string;
  resultBranch?: string;
  resultSha?: string;
  resultPrUrl?: string;
  /** Log events dropped by the runner's rate limit since the last snapshot (§3.2). */
  droppedLogs?: number;
}

export interface LifecycleEventPayload { level: 'info' | 'warn' | 'error'; message: string }
/** At most 8 KiB of text (§3.2). */
export interface LogEventPayload { stream: 'stdout' | 'stderr' | 'run'; text: string }

export interface RunnerEvent {
  /** Per job and lease epoch, starting at 1, contiguous. */
  seq: number;
  type: RunnerEventType;
  payload: StateEventPayload | SnapshotEventPayload | LifecycleEventPayload | LogEventPayload;
}

export interface JobReport { jobId: string; leaseEpoch: number; events: RunnerEvent[] }
export type CommandAckResult = 'ok' | 'rejected';
export interface CommandAck { commandId: string; leaseEpoch: number; result: CommandAckResult; detail?: string }
export interface TokenRequest { jobId: string; leaseEpoch: number }

export interface SyncRequest {
  protocolVersion: number;
  bootId: string;
  daemonVersion: string;
  /** Sent on the first sync after boot and whenever it changes. */
  capabilities?: RunnerCapabilities;
  freeSlots: number;
  jobs: JobReport[];
  commandAcks: CommandAck[];
  tokenRequests: TokenRequest[];
}

export interface GitIdentity { name: string; email: string }

/** ASSIGN carries everything the runner needs; never a secret (git tokens come via gitTokens). */
export interface AssignPayload {
  jobId: string;
  command: FleetJobKindName;
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string; defaultBranch: string; cloneUrl: string };
  ref: string;
  feature: string;
  planFrom: string | null;
  profiles: string[];
  /** Decimal string. */
  maxCostUsd: string;
  bashMode: 'raw';
  gitIdentity: GitIdentity;
}
export interface ReadoptPayload { naxRunId: string | null }
export interface AbandonPayload { reason: 'stale_lease' | 'job_terminal' }

export interface FleetCommandOut {
  commandId: string;
  type: FleetCommandTypeName;
  jobId: string;
  leaseEpoch: number;
  payload: AssignPayload | ReadoptPayload | AbandonPayload | Record<string, never>;
}

export interface GitToken { jobId: string; token: string; expiresAt: string; username: 'x-access-token' | 'oauth2' }
export interface GitTokenError { jobId: string; reason: string }
export interface JobAck { jobId: string; ackedSeq: number }

export interface SyncResponse {
  jobAcks: JobAck[];
  commands: FleetCommandOut[];
  gitTokens: GitToken[];
  /** Plan D7: why a requested token was not minted (fixed reason codes). */
  gitTokenErrors: GitTokenError[];
  /** Plan D7: reported jobs the server does not know; the runner abandons them. */
  unknownJobIds: string[];
  nextPollAfterMs?: number;
}
