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
  from?: Date;
  to?: Date;
}

/** What AuditRecorder puts in the package entry's `metadata`, and PrismaAuditStorage reads back. */
export interface KodaAuditMetadata {
  projectId: string | null;
  onBehalfOf: { type: ActorType; id: string } | null;
  origin: ActionOrigin;
  approval: ActionApproval;
  summary: string | null;
}
