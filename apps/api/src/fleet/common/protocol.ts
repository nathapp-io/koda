export type {
  AbandonPayload,
  ApprovalAnswerPayload,
  ApprovalOption,
  ApprovalRequestEventPayload,
  AssignPayload,
  BashMode,
  CommandAck,
  CommandAckResult,
  FleetCommandOut,
  FleetCommandTypeName,
  FleetJobKindName,
  FleetJobStateName,
  GitIdentity,
  GitToken,
  GitTokenError,
  EnrollRequest,
  EnrollResponse,
  InteractionCheck,
  JobAck,
  JobReport,
  LifecycleEventPayload,
  LogEventPayload,
  NaxProtocol,
  ProfileNeeds,
  ReadoptPayload,
  RunnerArch,
  RunnerCapabilities,
  RunnerCredential,
  RunnerEvent,
  RunnerEventType,
  RunnerExecutor,
  RunnerIdentity,
  RunnerOs,
  SnapshotEventPayload,
  StateEventPayload,
  SyncRequest,
  SyncResponse,
  TokenRequest,
} from '@nathapp/fleet-protocol';

/**
 * Protocol versions this API accepts. Kept local (not imported from the package at
 * runtime) because the production image does not ship workspace packages; the spec
 * pins it to FLEET_PROTOCOL_VERSION.
 * v3 (S2a): the runner streams logs over PUT .../logs/:stream instead of log events.
 */
export const SUPPORTED_FLEET_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1, 2, 3]);

export function isSupportedProtocolVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_FLEET_PROTOCOL_VERSIONS.includes(value);
}

/** Mirror of the package's APPROVAL_TEXT_MAX_BYTES (protocol.spec pins them equal). */
export const APPROVAL_TEXT_MAX_BYTES = 12_288;
/** S1.5 §1.6, A3. */
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
export const MIN_APPROVAL_TIMEOUT_SEC = 30;
export const MAX_APPROVAL_TIMEOUT_SEC = 3600;
