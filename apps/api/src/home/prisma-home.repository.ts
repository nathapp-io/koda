import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import {
  ACTIVE_JOB_STATES, FAILED_JOB_STATES, OPEN_TICKET_STATUSES, type HomeActivityRow, type HomeApprovalRow, type HomeApprovalScope,
  type HomeCaller, type HomeJobRow, type HomeProjectRow, type HomeTicketRow,
} from './home.types';

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
const JOB_NEWEST = (field: 'queuedAt' | 'finishedAt') => [{ [field]: 'desc' as const }, { id: 'desc' as const }];

@Injectable()
export class PrismaHomeRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Member projects for a user; every live project for a global admin (mirrors ProjectsService.findAllForPrincipal). */
  async findProjects(caller: HomeCaller): Promise<HomeProjectRow[]> {
    return this.prisma.client.project.findMany({
      where: {
        deletedAt: null,
        ...(caller.globalAdmin ? {} : { members: { some: { userId: caller.id } } }),
      },
      select: { id: true, name: true, key: true, slug: true, description: true },
      orderBy: { name: 'asc' },
    });
  }

  async findMyTickets(userId: string, projectIds: string[], take: number): Promise<HomeTicketRow[]> {
    return this.prisma.client.ticket.findMany({
      where: {
        assignedToUserId: userId,
        deletedAt: null,
        projectId: { in: projectIds },
        status: { in: [...OPEN_TICKET_STATUSES] },
      },
      select: {
        id: true, projectId: true, number: true, type: true, title: true, status: true, priority: true, updatedAt: true,
        project: { select: { key: true, slug: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  async countMyTickets(userId: string, projectIds: string[]): Promise<number> {
    return this.prisma.client.ticket.count({
      where: {
        assignedToUserId: userId,
        deletedAt: null,
        projectId: { in: projectIds },
        status: { in: [...OPEN_TICKET_STATUSES] },
      },
    });
  }

  /** Prisma ignores an empty `OR`, so an empty scope must short-circuit to a never-match where. */
  private static pendingWhere(scope: HomeApprovalScope): Record<string, unknown> {
    const or: Array<Record<string, unknown>> = [];
    if (scope.projectIds.length) or.push({ projectId: { in: scope.projectIds } });
    if (scope.includeUnscoped) or.push({ projectId: null });
    return or.length ? { status: 'pending', OR: or } : { status: 'pending', id: { in: [] } };
  }

  async findPendingApprovals(scope: HomeApprovalScope, take: number): Promise<HomeApprovalRow[]> {
    return this.prisma.client.fleetApproval.findMany({
      where: PrismaHomeRepository.pendingWhere(scope),
      select: { id: true, type: true, projectId: true, jobId: true, requestedAt: true, expiresAt: true },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  async countPendingApprovals(scope: HomeApprovalScope): Promise<number> {
    return this.prisma.client.fleetApproval.count({ where: PrismaHomeRepository.pendingWhere(scope) });
  }

  private static failedWhere(projectIds: string[], since: Date): Record<string, unknown> {
    return {
      projectId: { in: projectIds },
      state: { in: [...FAILED_JOB_STATES] },
      OR: [{ finishedAt: { gte: since } }, { finishedAt: null }],
    };
  }

  private static toJobRow = (r: {
    id: string; projectId: string; feature: string; command: string; state: string; stateReason: string | null;
    costSpentUsd: { toString(): string }; resultPrUrl: string | null; queuedAt: Date; finishedAt: Date | null;
    project: { slug: string };
  }): HomeJobRow => ({ ...r, costSpentUsd: r.costSpentUsd.toString() });

  async findFailedJobs(projectIds: string[], since: Date, take: number): Promise<HomeJobRow[]> {
    const rows = await this.prisma.client.fleetJob.findMany({
      where: PrismaHomeRepository.failedWhere(projectIds, since),
      select: {
        id: true, projectId: true, feature: true, command: true, state: true, stateReason: true, costSpentUsd: true,
        resultPrUrl: true, queuedAt: true, finishedAt: true,
        project: { select: { slug: true } },
      },
      orderBy: JOB_NEWEST('finishedAt'),
      take,
    });
    return rows.map(PrismaHomeRepository.toJobRow);
  }

  async countFailedJobs(projectIds: string[], since: Date): Promise<number> {
    return this.prisma.client.fleetJob.count({ where: PrismaHomeRepository.failedWhere(projectIds, since) });
  }

  async findBlockedJobs(jobIds: string[], take: number): Promise<HomeJobRow[]> {
    if (!jobIds.length) return [];
    const rows = await this.prisma.client.fleetJob.findMany({
      where: { id: { in: jobIds }, state: { in: [...ACTIVE_JOB_STATES] } },
      select: {
        id: true, projectId: true, feature: true, command: true, state: true, stateReason: true, costSpentUsd: true,
        resultPrUrl: true, queuedAt: true, finishedAt: true,
        project: { select: { slug: true } },
      },
      orderBy: JOB_NEWEST('queuedAt'),
      take,
    });
    return rows.map(PrismaHomeRepository.toJobRow);
  }

  async countBlockedJobs(jobIds: string[]): Promise<number> {
    if (!jobIds.length) return 0;
    return this.prisma.client.fleetJob.count({
      where: { id: { in: jobIds }, state: { in: [...ACTIVE_JOB_STATES] } },
    });
  }

  async countOpenTicketsByProject(projectIds: string[]): Promise<Map<string, number>> {
    if (!projectIds.length) return new Map();
    const rows = await this.prisma.client.ticket.groupBy({
      by: ['projectId'],
      where: { deletedAt: null, projectId: { in: projectIds }, status: { in: [...OPEN_TICKET_STATUSES] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.projectId, r._count._all]));
  }

  /** Attention jobs per project: recent failures plus jobs still waiting on a pending approval. */
  async countAttentionJobsByProject(projectIds: string[], since: Date, blockedJobIds: string[]): Promise<Map<string, number>> {
    if (!projectIds.length) return new Map();
    const or: Array<Record<string, unknown>> = [
      { state: { in: [...FAILED_JOB_STATES] }, OR: [{ finishedAt: { gte: since } }, { finishedAt: null }] },
    ];
    if (blockedJobIds.length) or.push({ id: { in: blockedJobIds }, state: { in: [...ACTIVE_JOB_STATES] } });
    const rows = await this.prisma.client.fleetJob.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, OR: or },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.projectId, r._count._all]));
  }

  async findRecentActivity(projectIds: string[], takePerTable: number): Promise<{
    ticketEvents: HomeActivityRow[];
    agentEvents: HomeActivityRow[];
    decisionEvents: HomeActivityRow[];
  }> {
    if (!projectIds.length) return { ticketEvents: [], agentEvents: [], decisionEvents: [] };
    const where = { projectId: { in: projectIds } };
    const [ticketEvents, agentEvents, decisionEvents] = await Promise.all([
      this.prisma.client.ticketEvent.findMany({
        where, select: { id: true, projectId: true, action: true, actorId: true, ticketId: true, createdAt: true },
        orderBy: NEWEST_FIRST, take: takePerTable,
      }),
      this.prisma.client.agentEvent.findMany({
        where, select: { id: true, projectId: true, action: true, actorId: true, createdAt: true },
        orderBy: NEWEST_FIRST, take: takePerTable,
      }),
      this.prisma.client.decisionEvent.findMany({
        where, select: { id: true, projectId: true, action: true, agentId: true, createdAt: true },
        orderBy: NEWEST_FIRST, take: takePerTable,
      }),
    ]);
    return {
      ticketEvents: ticketEvents.map((e) => ({ ...e, eventType: 'ticket_event' as const })),
      agentEvents: agentEvents.map((e) => ({ ...e, eventType: 'agent_event' as const, ticketId: null })),
      decisionEvents: decisionEvents.map((e) => ({
        id: e.id, projectId: e.projectId, eventType: 'decision_event' as const, action: e.action,
        actorId: e.agentId, ticketId: null, createdAt: e.createdAt,
      })),
    };
  }
}
