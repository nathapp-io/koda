import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { FleetJobKind, FleetJobState } from '../../common/enums';
import type { BashMode } from '../common/protocol';
import type { FleetJobStory } from '../jobs/domain/fleet-job.domain';
import { ACTIVE_STATES, RUNNER_HELD_STATES, TERMINAL_STATES } from '../jobs/job-state';
import type { DashboardJobRow, DashboardRecentRow, DashboardScope, PendingSummary } from './dashboard.types';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const JOB_SELECT = {
  id: true, projectId: true, repoId: true, feature: true, command: true, state: true, runnerId: true, currentStoryId: true, currentPhase: true,
  stories: true, storiesTruncated: true, costSpentUsd: true, maxCostUsd: true, queuedAt: true, assignedAt: true, startedAt: true,
  lastHeartbeatAt: true, profiles: true, selectorLabels: true, pinnedRunnerId: true, bashMode: true,
  project: { select: { slug: true, deletedAt: true } },
  repo: { select: { owner: true, name: true, provider: true } },
} satisfies Prisma.FleetJobSelect;

const RECENT_SELECT = {
  id: true, feature: true, command: true, state: true, stateReason: true, costSpentUsd: true, startedAt: true, finishedAt: true, resultPrUrl: true,
  project: { select: { slug: true } },
  repo: { select: { owner: true, name: true } },
  runner: { select: { name: true } },
} satisfies Prisma.FleetJobSelect;

type JobSelected = Prisma.FleetJobGetPayload<{ select: typeof JOB_SELECT }>;
type RecentSelected = Prisma.FleetJobGetPayload<{ select: typeof RECENT_SELECT }>;

const toJobRow = (r: JobSelected): DashboardJobRow => ({
  id: r.id, projectId: r.projectId, projectSlug: r.project.slug, projectDeleted: r.project.deletedAt !== null,
  repoId: r.repoId, repoOwner: r.repo.owner, repoName: r.repo.name, provider: r.repo.provider as DashboardJobRow['provider'],
  feature: r.feature, command: r.command as FleetJobKind, state: r.state as FleetJobState, runnerId: r.runnerId,
  currentStoryId: r.currentStoryId, currentPhase: r.currentPhase, stories: r.stories as unknown as FleetJobStory[] | null,
  storiesTruncated: r.storiesTruncated, costSpentUsd: r.costSpentUsd.toString(), maxCostUsd: r.maxCostUsd.toString(),
  queuedAt: r.queuedAt, assignedAt: r.assignedAt, startedAt: r.startedAt, lastHeartbeatAt: r.lastHeartbeatAt,
  profiles: r.profiles, selectorLabels: r.selectorLabels, pinnedRunnerId: r.pinnedRunnerId, bashMode: r.bashMode as BashMode,
});

const toRecentRow = (r: RecentSelected): DashboardRecentRow => ({
  id: r.id, projectSlug: r.project.slug, repoOwner: r.repo.owner, repoName: r.repo.name, feature: r.feature,
  command: r.command as FleetJobKind, state: r.state as FleetJobState, stateReason: r.stateReason, runnerName: r.runner?.name ?? null,
  costSpentUsd: r.costSpentUsd.toString(), startedAt: r.startedAt, finishedAt: r.finishedAt as Date, resultPrUrl: r.resultPrUrl,
});

/** Scoped reads never show a soft-deleted project (spec §1.1). */
const scopeWhere = (scope: DashboardScope): Prisma.FleetJobWhereInput => ({
  project: { deletedAt: null },
  ...(scope.kind === 'project' ? { projectId: scope.projectId } : {}),
});

/** S2b (c) spec §1.3 (D402): the dashboard's own non-locking reads. */
@Injectable()
export class PrismaDashboardRepository implements IDashboardRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findRunners(): Promise<RawRunnerRow[]> {
    return this.db.runner.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, os: true, arch: true, labels: true, enabled: true, lastSeenAt: true, capacity: true, daemonVersion: true, capabilities: true },
    });
  }

  async findHeldRefs(): Promise<Array<{ runnerId: string; repoId: string }>> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...RUNNER_HELD_STATES] }, runnerId: { not: null } },
      orderBy: { id: 'asc' },
      select: { runnerId: true, repoId: true },
    });
    return rows.map((r) => ({ runnerId: r.runnerId as string, repoId: r.repoId }));
  }

  async findActiveJobs(scope: DashboardScope, limit: number): Promise<DashboardJobRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...ACTIVE_STATES] }, ...scopeWhere(scope) },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: limit, select: JOB_SELECT,
    });
    return rows.map(toJobRow);
  }

  async findQueuedWindow(limit: number): Promise<DashboardJobRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: FleetJobState.QUEUED },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: limit, select: JOB_SELECT,
    });
    return rows.map(toJobRow);
  }

  async findRecentJobs(scope: DashboardScope, finishedSince: Date, limit: number): Promise<DashboardRecentRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...TERMINAL_STATES] }, finishedAt: { gte: finishedSince }, ...scopeWhere(scope) },
      orderBy: [{ finishedAt: 'desc' }, { id: 'asc' }], take: limit, select: RECENT_SELECT,
    });
    return rows.map(toRecentRow);
  }

  async countActiveByState(scope: DashboardScope): Promise<Map<string, number>> {
    const groups = await this.db.fleetJob.groupBy({
      by: ['state'], where: { state: { in: [...ACTIVE_STATES] }, ...scopeWhere(scope) }, _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.state, g._count._all]));
  }

  async pendingSummaryByJob(jobIds: readonly string[]): Promise<PendingSummary[]> {
    if (jobIds.length === 0) return [];
    const groups = await this.db.fleetApproval.groupBy({
      by: ['jobId'], where: { status: 'pending', jobId: { in: [...jobIds] } }, _count: { _all: true }, _min: { requestedAt: true },
    });
    return groups.flatMap((g) => (g.jobId !== null && g._min.requestedAt !== null
      ? [{ jobId: g.jobId, count: g._count._all, oldestRequestedAt: g._min.requestedAt }]
      : []));
  }
}
