/**
 * Koda fleet protocol (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md).
 * Shared by apps/api (type-only) and apps/runner. Bump FLEET_PROTOCOL_VERSION on any
 * incompatible wire change. v2 (S1.5): approval relay. v3 (S2a): logs stream over
 * PUT /fleet/runner/jobs/:jobId/logs/:stream; a v3 runner sends no `log` sync events.
 */
export const FLEET_PROTOCOL_VERSION = 3 as const;

/** S1.5 §1.6: `gated` and `escalate` relay nax bash asks to the approvals inbox (protocol v2 runners only). */
export type BashMode = 'raw' | 'gated' | 'escalate';

export type RunnerOs = 'darwin' | 'linux';
export type RunnerArch = 'arm64' | 'x64';
export type NaxProtocol = 'acp' | 'native';
export type RunnerExecutor = 'host';

export interface ProfileNeeds {
  protocol: NaxProtocol;
  providers: string[];
  sandbox: boolean;
}

/** nax's verdict on one provider, mirroring `nax auth list --json` without account labels (slice 3 design §1.1). */
export type RunnerCredentialExec = 'served' | 'declined' | 'error';
export interface RunnerCredentialStored { kind: 'api-key' | 'oauth'; expires?: string; expired: boolean }
export interface RunnerCredential {
  providerId: string;
  /** nax's verdict: stored, exec-served or ambient. Placement follows it (it ignores access-token expiry on purpose). */
  available: boolean;
  stored: RunnerCredentialStored | null;
  /** Present when nax `auth.source` is exec. */
  exec?: RunnerCredentialExec;
  ambient: boolean;
}

/**
 * Validated by the server (#161): `nax.protocols` non-empty and unique; at most 64 profiles
 * named /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, each with at most 16 providers; at most 64
 * credentials; `stored.expires`, when present, must parse as a date. Whole report at most 64 KiB.
 */
export interface RunnerCapabilities {
  nax: { version: string; protocols: NaxProtocol[] };
  sandbox: { available: boolean; probedAt: string; error?: string };
  profiles: Record<string, ProfileNeeds>;
  credentials: RunnerCredential[];
  tools: { git: boolean; gh: boolean; glab: boolean };
  executors: RunnerExecutor[];
  /** S1.5 §3: present only when the runner hosts the nax approval relay (protocol v2, nax >= 0.83.0). */
  approvals?: { relay: true };
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
export type FleetCommandTypeName = 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON' | 'APPROVAL_ANSWER';
export type RunnerEventType = 'state' | 'snapshot' | 'lifecycle' | 'log' | 'approval_request';

/** A runner-reported transition (§5.4 runner-owned rows only). */
export interface StateEventPayload { to: FleetJobStateName; reason?: string; exitCode?: number }

/** S1b §1.2: one PRD user story, as the runner read it from nax's prd.json. */
export interface SnapshotStory {
  id: string;
  /** At most 80 UTF-16 units. */
  title: string;
  /** nax's story status, passed through (`pending`, `in-progress`, `passed`, ...). */
  status: string;
  attempts: number;
  /** nax's `dependencies`, at most 10 ids. */
  dependsOn: string[];
}

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
  /** S1b §1.1: outcome of the runner's work-in-progress push after an unfinished RUN.
   *  `pushed` | `none` | `failed:<reason>` (printable ASCII, at most 200 chars of reason). */
  wipPush?: string;
  /** S1b §1.2: the PRD's stories in PRD order, sent only when changed. At most 100 stories and 8 KiB serialized. */
  stories?: SnapshotStory[];
  /** S1b §1.2: true when the runner cut `stories` to fit; sent with `stories`. */
  storiesTruncated?: boolean;
  /** Log events dropped by the runner's rate limit since the last snapshot (§3.2). */
  droppedLogs?: number;
}

/** STYLE-3: `details` is a free-form array of structured items the runner wants attached to a lifecycle event
 *  (e.g. the unsafe names left out of a bundle). The server ignores it; it is opaque telemetry. */
export interface LifecycleEventPayload { level: 'info' | 'warn' | 'error'; message: string; details?: readonly unknown[] }
/** At most 8 KiB of text (§3.2). */
export interface LogEventPayload { stream: 'stdout' | 'stderr' | 'run'; text: string }

// ---- S1.5 slice 2a: approval relay (spec §3, §4) ----

/** The choices nax offers on a bash ask; `allow-remember` only when nax can remember it. */
export type ApprovalOption = 'allow' | 'allow-remember' | 'deny';

/** Cap for `command` and `rawDetail` (UTF-8 bytes); keeps the event under the 16 KiB sync payload limit. */
export const APPROVAL_TEXT_MAX_BYTES = 12_288;

/**
 * One nax bash ask, relayed by the runner (spec §1.2, plan D256/D283). `command` is nax's masked command; on a
 * detail the runner could not parse, `command` is '' and `rawDetail` holds nax's text. `commandTruncated` is true
 * when either text was cut to the cap; such an ask can only be denied.
 */
export interface ApprovalRequestEventPayload {
  /** nax's request id, `ask-<hex>`. */
  naxAskId: string;
  /** ISO time: nax's `createdAt + timeout` (plan D257). */
  deadlineAt: string;
  command: string;
  commandTruncated: boolean;
  maskedCount: number;
  root: string;
  stage: string;
  storyId: string | null;
  featureName: string;
  reason: string;
  options: ApprovalOption[];
  rawDetail?: string;
}

/** Server -> runner: the human's answer to one ask. */
export interface ApprovalAnswerPayload { approvalId: string; naxAskId: string; choice: ApprovalOption }

export interface RunnerEvent {
  /** Per job and lease epoch, starting at 1, contiguous. */
  seq: number;
  type: RunnerEventType;
  payload: StateEventPayload | SnapshotEventPayload | LifecycleEventPayload | LogEventPayload | ApprovalRequestEventPayload;
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
  bashMode: BashMode;
  /** S1.5 §1.6: seconds nax waits on a bash ask; 30..3600. Used only when bashMode is not raw. */
  approvalTimeoutSec: number;
  gitIdentity: GitIdentity;
}
export interface ReadoptPayload { naxRunId: string | null }
export interface AbandonPayload { reason: 'stale_lease' | 'job_terminal' }

export interface FleetCommandOut {
  commandId: string;
  type: FleetCommandTypeName;
  jobId: string;
  leaseEpoch: number;
  payload: AssignPayload | ReadoptPayload | AbandonPayload | ApprovalAnswerPayload | Record<string, never>;
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

// ---- Slice 2b: bundle upload (spec §3.3) ----

/**
 * `PUT /fleet/runner/jobs/:jobId/bundle?leaseEpoch=<epoch>` with header
 * `X-Content-SHA256` (lowercase hex of the body) and content-type `application/gzip`.
 * Fenced: the runner must hold the job's (runnerId, leaseEpoch); a stale epoch answers
 * 409 and queues an ABANDON command. Known limit (S1, documented, not fixed): a body
 * sent without `Content-Length` that crosses `FLEET_BUNDLE_MAX_BYTES` mid-stream is
 * destroyed by the server's streaming pipeline, so the client sees a connection reset
 * instead of 413. The slice 3 runner always sends `Content-Length` (it uploads a
 * finished file), so the server answers 413 before reading the body.
 */
