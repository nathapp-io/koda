/**
 * Local TypeScript enum definitions for the Koda API.
 * A historical SQLite constraint (no native Prisma enum support there) keeps these
 * defined here as const objects with string literal types; conversion to native
 * Postgres enums is tracked debt.
 */

export const TicketStatus = {
  CREATED: 'CREATED',
  VERIFIED: 'VERIFIED',
  IN_PROGRESS: 'IN_PROGRESS',
  VERIFY_FIX: 'VERIFY_FIX',
  CLOSED: 'CLOSED',
  REJECTED: 'REJECTED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const TicketType = {
  BUG: 'BUG',
  ENHANCEMENT: 'ENHANCEMENT',
  TASK: 'TASK',
  QUESTION: 'QUESTION',
} as const;
export type TicketType = (typeof TicketType)[keyof typeof TicketType];

export const Priority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const CommentType = {
  GENERAL: 'GENERAL',
  VERIFICATION: 'VERIFICATION',
  FIX_REPORT: 'FIX_REPORT',
  REVIEW: 'REVIEW',
  STATUS_CHANGE: 'STATUS_CHANGE',
} as const;
export type CommentType = (typeof CommentType)[keyof typeof CommentType];

export const ActivityType = {
  STATUS_CHANGE: 'STATUS_CHANGE',
  ASSIGNMENT: 'ASSIGNMENT',
  COMMENT: 'COMMENT',
  LABEL_CHANGE: 'LABEL_CHANGE',
  VCS_PR_CREATED: 'VCS_PR_CREATED',
  VCS_PR_MERGED: 'VCS_PR_MERGED',
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export const AgentRole = {
  VERIFIER: 'VERIFIER',
  DEVELOPER: 'DEVELOPER',
  REVIEWER: 'REVIEWER',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const AGENT_ROLES = ['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'] as const;
export type AgentRoleNames = typeof AGENT_ROLES[number];

export const ActorRole = {
  ADMIN: 'ADMIN',
  DEVELOPER: 'DEVELOPER',
  AGENT: 'AGENT',
  MEMBER: 'MEMBER',
  VIEWER: 'VIEWER',
} as const;
export type ActorRole = (typeof ActorRole)[keyof typeof ActorRole];

/**
 * Roles that may be stored on a ProjectMember row today. Legacy rows can still
 * carry 'AGENT' or 'MEMBER' (pre-PROJECT_MEMBER_ROLES narrowing); the membership
 * gate accepts them but the CASL factory collapses them to the VIEWER least-
 * privilege set (see KodaCaslAbilityFactory.projectRolePermissions). The `(string
 * & {})` escape hatch keeps `ProjectMemberRole` assignable from arbitrary
 * legacy DB strings while still surfacing typos at every typed call site.
 */
export const PROJECT_MEMBER_ROLES = ['ADMIN', 'DEVELOPER', 'VIEWER'] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number] | (string & {});

export const AutoAssignMode = { OFF: 'OFF', SUGGEST: 'SUGGEST', AUTO: 'AUTO' } as const;
export type AutoAssignMode = typeof AutoAssignMode[keyof typeof AutoAssignMode];

export const MemoryKind = {
  FACT: 'FACT',
  DECISION: 'DECISION',
  PREFERENCE: 'PREFERENCE',
  CONSTRAINT: 'CONSTRAINT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
} as const;
export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

export const EntityNodeType = {
  TICKET: 'ticket',
  SERVICE: 'service',
  OWNER: 'owner',
  INCIDENT: 'incident',
  CODE_MODULE: 'code_module',
} as const;
export type EntityNodeType = (typeof EntityNodeType)[keyof typeof EntityNodeType];

export const EntityLinkRelation = {
  TICKET_TO_SERVICE: 'ticket_to_service',
  TICKET_TO_OWNER: 'ticket_to_owner',
  SERVICE_TO_SERVICE: 'service_to_service',
  INCIDENT_TO_TICKET: 'incident_to_ticket',
} as const;
export type EntityLinkRelation = (typeof EntityLinkRelation)[keyof typeof EntityLinkRelation];

/** Fleet S1: forge of a registered fleet repo (same spelling as VcsConnection.provider). */
export const FleetProvider = {
  GITHUB: 'github',
  GITLAB: 'gitlab',
} as const;
export type FleetProvider = (typeof FleetProvider)[keyof typeof FleetProvider];

/** Fleet S1: who performed a FleetActivity action. */
export const FleetActorType = {
  USER: 'USER',
  RUNNER: 'RUNNER',
  SYSTEM: 'SYSTEM',
} as const;
export type FleetActorType = (typeof FleetActorType)[keyof typeof FleetActorType];

/** Fleet S1: FleetJob.state (spec §2, §5.4). */
export const FleetJobState = {
  QUEUED: 'QUEUED', ASSIGNED: 'ASSIGNED', RUNNING: 'RUNNING', UPLOADING: 'UPLOADING',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED', ESCALATED: 'ESCALATED', CRASHED: 'CRASHED', CANCELLED: 'CANCELLED',
} as const;
export type FleetJobState = (typeof FleetJobState)[keyof typeof FleetJobState];

/** Fleet S1: FleetJob.command. */
export const FleetJobKind = { RUN: 'RUN', PLAN: 'PLAN' } as const;
export type FleetJobKind = (typeof FleetJobKind)[keyof typeof FleetJobKind];

/** Fleet S1: FleetCommand.type. */
export const FleetCommandType = { ASSIGN: 'ASSIGN', CANCEL: 'CANCEL', READOPT: 'READOPT', ABANDON: 'ABANDON' } as const;
export type FleetCommandType = (typeof FleetCommandType)[keyof typeof FleetCommandType];

/** Fleet S1: FleetCommand.ackResult. `withdrawn` and `stale` are server-set (plan D4, D8). */
export const FleetCommandAckResult = { OK: 'ok', REJECTED: 'rejected', WITHDRAWN: 'withdrawn', STALE: 'stale' } as const;
export type FleetCommandAckResult = (typeof FleetCommandAckResult)[keyof typeof FleetCommandAckResult];
