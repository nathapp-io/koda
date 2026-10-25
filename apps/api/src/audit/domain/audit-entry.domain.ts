import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { ActionApproval, ActionActorType, ActionOrigin, ActorType } from '../../action-context/action-context';

export const AUDIT_ENTRY_REPOSITORY = Symbol('AUDIT_ENTRY_REPOSITORY');
export const AUDIT_SUMMARY_MAX = 500;

export interface AuditEntryRecord {
  id?: string;
  key: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  actorType: ActionActorType;
  actorId: string;
  onBehalfOfType: ActorType | null;
  onBehalfOfId: string | null;
  origin: ActionOrigin;
  requiredMode: ActionApproval['requiredMode'];
  satisfiedBy: ActionApproval['satisfiedBy'];
  approverType: ActorType | null;
  approverId: string | null;
  approvalRequestId: string | null;
  correlationId: string;
  summary: string | null;
  createdAt: Date;
}

export interface AuditEntryFilters {
  key?: string;
  actorType?: ActionActorType;
  actorId?: string;
  approverId?: string;
  projectId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Exact match on the action context's correlation id: every write of one request or run. */
  correlationId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Resolved display labels for one audit entry (Permissions P2 US-001). The audit row stores ids
 * only — they are not foreign keys — so the names a human reads are projected per page and never
 * change the entry's own fields.
 */
export interface AuditDisplay {
  /** USER: name, else email; AGENT: agent name; RUNNER: runner name; SYSTEM: null (the web shows the component id). */
  actor: string | null;
  /** USER: name, else email; AGENT: agent name; null when the entry has no on-behalf-of principal. */
  onBehalfOf: string | null;
  /** USER: name, else email; AGENT: agent name; null when the entry has no approver. */
  approver: string | null;
  /** null when the entry carries no projectId. */
  project: { slug: string; name: string } | null;
}

/** The display block of an entry whose principal and project resolve to nothing. */
export const EMPTY_AUDIT_DISPLAY: AuditDisplay = Object.freeze({
  actor: null,
  onBehalfOf: null,
  approver: null,
  project: null,
});

/** The distinct ids one page needs labels for, split by the table that owns each kind. */
export interface AuditDisplayIds {
  userIds: string[];
  agentIds: string[];
  runnerIds: string[];
  projectIds: string[];
}

/** Label projection for one page of audit entries, keyed by id. A missing id stays unresolved. */
export interface AuditDisplayNames {
  users: Map<string, string>;
  agents: Map<string, string>;
  runners: Map<string, string>;
  projects: Map<string, { slug: string; name: string }>;
}

/** What AuditRecorder puts in the package entry's `metadata`, and PrismaAuditStorage reads back. */
export interface KodaAuditMetadata {
  projectId: string | null;
  onBehalfOf: { type: ActorType; id: string } | null;
  origin: ActionOrigin;
  approval: ActionApproval;
  summary: string | null;
}
