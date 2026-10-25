import { Injectable } from '@nestjs/common';
import { ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { ActionActorType, ActorType } from '../action-context/action-context';
import { remapPage } from '../common/dto/koda-page.query';
import type { AuditDisplay, AuditDisplayIds, AuditDisplayNames, AuditEntryFilters, AuditEntryRecord } from './domain/audit-entry.domain';
import { AuditEntryDto } from './dto/audit-entry.dto';
import { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';

export interface AuditListQuery {
  key?: string;
  actorType?: ActionActorType;
  actorId?: string;
  approverId?: string;
  projectId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Exact match on the action context's correlation id (Permissions P2 US-002). */
  correlationId?: string;
  from?: string;
  to?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function asUtcBoundary(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (value === undefined) return undefined;
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return new Date(value);
}

/** One page's principals and projects, split by the table that owns each kind and deduplicated. */
function collectDisplayIds(records: readonly AuditEntryRecord[]): AuditDisplayIds {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const runnerIds = new Set<string>();
  const projectIds = new Set<string>();

  const addPrincipal = (type: ActionActorType | ActorType | null, id: string | null): void => {
    if (type === null || id === null) return;
    if (type === 'USER') userIds.add(id);
    else if (type === 'AGENT') agentIds.add(id);
    else if (type === 'RUNNER') runnerIds.add(id);
    // SYSTEM ids name a component (`scheduler`, `outbox`, ...), not a row: never looked up.
  };

  for (const record of records) {
    addPrincipal(record.actorType, record.actorId);
    addPrincipal(record.onBehalfOfType, record.onBehalfOfId);
    addPrincipal(record.approverType, record.approverId);
    if (record.projectId !== null) projectIds.add(record.projectId);
  }

  return { userIds: [...userIds], agentIds: [...agentIds], runnerIds: [...runnerIds], projectIds: [...projectIds] };
}

function isEmpty(ids: AuditDisplayIds): boolean {
  return ids.userIds.length === 0 && ids.agentIds.length === 0 && ids.runnerIds.length === 0 && ids.projectIds.length === 0;
}

function noNames(): AuditDisplayNames {
  return { users: new Map(), agents: new Map(), runners: new Map(), projects: new Map() };
}

function principalLabel(type: ActionActorType | ActorType | null, id: string | null, names: AuditDisplayNames): string | null {
  if (type === null || id === null) return null;
  if (type === 'USER') return names.users.get(id) ?? null;
  if (type === 'AGENT') return names.agents.get(id) ?? null;
  if (type === 'RUNNER') return names.runners.get(id) ?? null;
  return null;
}

/** The display block of one entry, read from the batch's maps. An id with no row stays null. */
function displayFor(record: AuditEntryRecord, names: AuditDisplayNames): AuditDisplay {
  return {
    actor: principalLabel(record.actorType, record.actorId, names),
    onBehalfOf: principalLabel(record.onBehalfOfType, record.onBehalfOfId, names),
    approver: principalLabel(record.approverType, record.approverId, names),
    project: record.projectId === null ? null : (names.projects.get(record.projectId) ?? null),
  };
}

@Injectable()
export class AuditLogService {
  constructor(private readonly repo: PrismaAuditEntryRepository) {}

  async list(query: AuditListQuery, page: IPageOption): Promise<IPageResult<AuditEntryDto>> {
    const from = asUtcBoundary(query.from, false);
    const to = asUtcBoundary(query.to, true);
    if (from && to && from.getTime() > to.getTime()) {
      throw new ValidationAppException({ reason: 'from must not be after to' }, 'audit.auditQuery');
    }
    const filters: AuditEntryFilters = {
      ...(query.key !== undefined ? { key: query.key } : {}),
      ...(query.actorType !== undefined ? { actorType: query.actorType } : {}),
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.approverId !== undefined ? { approverId: query.approverId } : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.resourceType !== undefined ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
      ...(query.correlationId !== undefined ? { correlationId: query.correlationId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    };
    const result = await this.repo.findPage(filters, page);
    const ids = collectDisplayIds(result.records);
    // One label batch per page — and none at all for an empty page or one that names no row.
    const names = isEmpty(ids) ? noNames() : await this.repo.findDisplayNames(ids);
    return remapPage(result, (record) => AuditEntryDto.from(record, displayFor(record, names)));
  }

  /**
   * Every key that occurs in the log, sorted ascending (Permissions P2 US-002). The set is small —
   * the catalog's keys plus the `thread.*`, `runner.*` and `system.*` ones — so the page filter reads
   * it whole; the permission catalog cannot answer it, because it does not list every key a write uses.
   */
  async keys(): Promise<string[]> {
    return this.repo.findDistinctKeys();
  }
}
