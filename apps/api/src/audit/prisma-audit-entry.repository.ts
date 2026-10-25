import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaModelDelegate, PrismaService, Paginate } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult, ITransactionManager } from '@nathapp/nestjs-data';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AuditEntry as AuditEntryModel, Prisma, PrismaClient } from '../generated/prisma/client';
import type { AuditDisplayIds, AuditDisplayNames, AuditEntryFilters, AuditEntryRecord } from './domain/audit-entry.domain';

/** A user's label: the name it chose, or its email when the name is missing or blank. */
function userLabel(name: string | null, email: string): string {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? email : trimmed;
}

/** Reads one kind's label rows, or nothing at all when the page named no id of that kind. */
function rowsFor<T>(ids: string[], load: () => Promise<T[]>): Promise<T[]> {
  return ids.length === 0 ? Promise.resolve([]) : load();
}

@Injectable()
export class PrismaAuditEntryRepository extends AbstractPrismaRepository<AuditEntryRecord, AuditEntryModel, string> {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }

  protected modelDelegate(client: unknown): PrismaModelDelegate<AuditEntryModel, string> {
    return (client as Record<string, unknown>).auditEntry as PrismaModelDelegate<AuditEntryModel, string>;
  }
  protected toDomain(m: AuditEntryModel): AuditEntryRecord {
    return { ...m } as AuditEntryRecord;
  }
  protected toPersistenceCreate(d: AuditEntryRecord) {
    return {
      key: d.key, resourceType: d.resourceType, resourceId: d.resourceId, projectId: d.projectId,
      actorType: d.actorType, actorId: d.actorId, onBehalfOfType: d.onBehalfOfType, onBehalfOfId: d.onBehalfOfId,
      origin: d.origin, requiredMode: d.requiredMode, satisfiedBy: d.satisfiedBy, approverType: d.approverType,
      approverId: d.approverId, approvalRequestId: d.approvalRequestId, correlationId: d.correlationId,
      summary: d.summary, createdAt: d.createdAt,
    };
  }
  protected toPersistenceUpdate(): never { throw new Error('audit entries are append-only'); }

  async findPage(filters: AuditEntryFilters, page: IPageOption): Promise<IPageResult<AuditEntryRecord>> {
    const where: Prisma.AuditEntryWhereInput = {
      ...(filters.key !== undefined ? { key: filters.key } : {}),
      ...(filters.actorType !== undefined ? { actorType: filters.actorType } : {}),
      ...(filters.actorId !== undefined ? { actorId: filters.actorId } : {}),
      ...(filters.approverId !== undefined ? { approverId: filters.approverId } : {}),
      ...(filters.projectId !== undefined ? { projectId: filters.projectId } : {}),
      ...(filters.resourceType !== undefined ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId !== undefined ? { resourceId: filters.resourceId } : {}),
      ...((filters.from !== undefined || filters.to !== undefined) ? { createdAt: {
        ...(filters.from !== undefined ? { gte: filters.from } : {}),
        ...(filters.to !== undefined ? { lte: filters.to } : {}),
      } } : {}),
    };
    const rows = await Paginate(this.prisma.client.auditEntry, page, { where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((m: AuditEntryModel) => this.toDomain(m));
  }

  /**
   * One page's display labels, in at most one `findMany` per non-empty kind (Permissions P2 US-001).
   *
   * Designer's call: this reads the label columns of `User`, `Agent`, `Runner` and `Project` from the
   * audit repository instead of the owning modules' services — no module exports a by-ids label
   * lookup, and wiring four domain modules into the global `AuditLogModule` would couple it to all of
   * them for one read-only projection. Only `id` and the label columns are selected, and nothing is
   * written. Each list is bounded by one page's ids (at most 100 entries per kind).
   */
  async findDisplayNames(ids: AuditDisplayIds): Promise<AuditDisplayNames> {
    const [users, agents, runners, projects] = await Promise.all([
      rowsFor(ids.userIds, () => this.prisma.client.user.findMany({
        where: { id: { in: ids.userIds } },
        select: { id: true, name: true, email: true },
      })),
      rowsFor(ids.agentIds, () => this.prisma.client.agent.findMany({
        where: { id: { in: ids.agentIds } },
        select: { id: true, name: true },
      })),
      rowsFor(ids.runnerIds, () => this.prisma.client.runner.findMany({
        where: { id: { in: ids.runnerIds } },
        select: { id: true, name: true },
      })),
      // No `deletedAt` filter: a soft-deleted project still resolves, the audit log is history.
      rowsFor(ids.projectIds, () => this.prisma.client.project.findMany({
        where: { id: { in: ids.projectIds } },
        select: { id: true, slug: true, name: true },
      })),
    ]);

    return {
      users: new Map(users.map((row) => [row.id, userLabel(row.name, row.email)])),
      agents: new Map(agents.map((row) => [row.id, row.name])),
      runners: new Map(runners.map((row) => [row.id, row.name])),
      projects: new Map(projects.map((row) => [row.id, { slug: row.slug, name: row.name }])),
    };
  }
}
