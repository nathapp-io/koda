import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TERMINAL_STATES } from '../jobs/job-state';
import type { ILogRetentionRepository, RetentionCandidate, RetentionCursor } from './domain/log-retention.domain';

@Injectable()
export class PrismaLogRetentionRepository implements ILogRetentionRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findCandidates(before: Date, after: RetentionCursor | null, limit: number): Promise<RetentionCandidate[]> {
    const rows = await this.db.fleetJob.findMany({
      where: {
        state: { in: [...TERMINAL_STATES] },
        finishedAt: { lt: before },
        OR: [
          { logs: { some: { expiredAt: null } } },
          { artifacts: { some: { expiredAt: null } } },
          { events: { some: { type: 'log' } } },
        ],
        ...(after ? { AND: [{ OR: [{ finishedAt: { gt: after.finishedAt } }, { finishedAt: after.finishedAt, id: { gt: after.id } }] }] } : {}),
      },
      orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, leaseEpoch: true, finishedAt: true },
    });
    return rows.map((r) => ({ id: r.id, leaseEpoch: r.leaseEpoch, finishedAt: r.finishedAt as Date }));
  }

  async findBundleKeys(jobId: string, maxEpoch: number): Promise<string[]> {
    const rows = await this.db.fleetJobArtifact.findMany({
      where: { jobId, leaseEpoch: { lte: maxEpoch }, expiredAt: null }, select: { storageKey: true }, orderBy: { leaseEpoch: 'asc' },
    });
    return rows.map((r) => r.storageKey);
  }

  async expireRows(jobId: string, maxEpoch: number, now: Date): Promise<{ events: number; logs: number; artifacts: number }> {
    const older = { jobId, leaseEpoch: { lte: maxEpoch } };
    const events = await this.db.fleetJobEvent.deleteMany({ where: { ...older, type: 'log' } });
    const logs = await this.db.fleetJobLog.updateMany({ where: { ...older, expiredAt: null }, data: { expiredAt: now } });
    const artifacts = await this.db.fleetJobArtifact.updateMany({ where: { ...older, expiredAt: null }, data: { expiredAt: now } });
    return { events: events.count, logs: logs.count, artifacts: artifacts.count };
  }
}
