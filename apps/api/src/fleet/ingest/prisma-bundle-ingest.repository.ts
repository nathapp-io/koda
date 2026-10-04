import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { TERMINAL_STATES } from '../jobs/job-state';
import {
  IBundleIngestRepository, INGEST_STALE_CLAIM_MS, IngestArtifact, IngestClaim, IngestContext, IngestListRow, IngestOutcome,
  IngestRows, IngestStatus,
} from './domain/bundle-ingest.domain';

const RESET = { status: 'pending', attempts: 0, nextAttemptAt: null, claimedAt: null, error: null } as const;

@Injectable()
export class PrismaBundleIngestRepository implements IBundleIngestRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async enqueue(artifactId: string, jobId: string, leaseEpoch: number, parserVersion: number): Promise<void> {
    await this.db.fleetBundleIngest.upsert({
      where: { artifactId },
      create: { artifactId, jobId, leaseEpoch, parserVersion },
      update: { ...RESET, parserVersion },
    });
  }

  async claimNext(now: Date): Promise<IngestClaim | null> {
    const stale = new Date(now.getTime() - INGEST_STALE_CLAIM_MS);
    const rows = await this.db.$queryRaw<IngestClaim[]>(Prisma.sql`
      UPDATE "FleetBundleIngest" i SET "status" = 'running', "claimedAt" = ${now}, "updatedAt" = ${now}
      WHERE i."id" = (
        SELECT c."id" FROM "FleetBundleIngest" c JOIN "FleetJob" j ON j."id" = c."jobId"
        WHERE j."state" IN (${Prisma.join([...TERMINAL_STATES])})
          AND ((c."status" = 'pending' AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${now}))
            OR (c."status" = 'running' AND c."claimedAt" < ${stale}))
        ORDER BY c."createdAt" ASC, c."id" ASC
        FOR UPDATE OF c SKIP LOCKED
        LIMIT 1
      )
      RETURNING i."id", i."artifactId", i."jobId", i."leaseEpoch", i."attempts"`);
    return rows[0] ?? null;
  }

  async findArtifact(artifactId: string): Promise<IngestArtifact | null> {
    return this.db.fleetJobArtifact.findUnique({ where: { id: artifactId }, select: { storageKey: true, expiredAt: true } });
  }

  async replaceRows(ctx: IngestContext, rows: IngestRows): Promise<void> {
    const where = { jobId: ctx.jobId, leaseEpoch: ctx.leaseEpoch };
    await this.db.fleetCostEvent.deleteMany({ where });
    await this.db.fleetStoryResult.deleteMany({ where });
    await this.db.fleetReviewResult.deleteMany({ where });
    const shared = { jobId: ctx.jobId, leaseEpoch: ctx.leaseEpoch, projectId: ctx.projectId };
    if (rows.costEvents.length > 0) {
      await this.db.fleetCostEvent.createMany({
        data: rows.costEvents.map((r) => ({ ...shared, ...r, repoId: ctx.repoId, runnerId: ctx.runnerId, naxRunId: ctx.naxRunId, costUsd: new Prisma.Decimal(r.costUsd) })),
      });
    }
    if (rows.stories.length > 0) {
      await this.db.fleetStoryResult.createMany({
        data: rows.stories.map((r) => ({ ...shared, ...r, repoId: ctx.repoId, costUsd: new Prisma.Decimal(r.costUsd) })),
      });
    }
    if (rows.reviews.length > 0) {
      await this.db.fleetReviewResult.createMany({
        data: rows.reviews.map((r) => ({ ...shared, ...r, findingsBySeverity: r.findingsBySeverity as Prisma.InputJsonValue })),
      });
    }
  }

  async markOutcome(id: string, o: IngestOutcome): Promise<void> {
    await this.db.fleetBundleIngest.update({
      where: { id },
      data: {
        status: o.kind, files: o.files as Prisma.InputJsonValue, ingestedAt: o.ingestedAt, claimedAt: null, error: null, nextAttemptAt: null,
        liveCostUsd: o.liveCostUsd === null ? null : new Prisma.Decimal(o.liveCostUsd), ledgerCostUsd: new Prisma.Decimal(o.ledgerCostUsd),
      },
    });
  }

  async markRetry(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void> {
    await this.db.fleetBundleIngest.update({ where: { id }, data: { status: 'pending', attempts, nextAttemptAt, claimedAt: null, error } });
  }

  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db.fleetBundleIngest.update({ where: { id }, data: { status: 'failed', attempts, claimedAt: null, nextAttemptAt: null, error } });
  }

  async backfill(parserVersion: number): Promise<number> {
    const missing = await this.db.fleetJobArtifact.findMany({
      where: { kind: 'bundle', expiredAt: null, ingest: null }, select: { id: true, jobId: true, leaseEpoch: true },
    });
    if (missing.length === 0) return 0;
    const { count } = await this.db.fleetBundleIngest.createMany({
      data: missing.map((a) => ({ artifactId: a.id, jobId: a.jobId, leaseEpoch: a.leaseEpoch, parserVersion })), skipDuplicates: true,
    });
    return count;
  }

  async rerunJob(jobId: string): Promise<number> {
    const { count } = await this.db.fleetBundleIngest.updateMany({ where: { jobId }, data: RESET });
    return count;
  }

  async rerunOutdated(parserVersion: number): Promise<number> {
    const { count } = await this.db.fleetBundleIngest.updateMany({
      where: { parserVersion: { lt: parserVersion }, status: { in: ['done', 'partial', 'failed'] }, artifact: { expiredAt: null } },
      data: { ...RESET, parserVersion },
    });
    return count;
  }

  async findPage(filters: { status?: IngestStatus }, page: IPageOption): Promise<IPageResult<IngestListRow>> {
    const rows = await Paginate(this.db.fleetBundleIngest, page, {
      where: filters.status ? { status: filters.status } : {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true, jobId: true, leaseEpoch: true, status: true, attempts: true, parserVersion: true, files: true, error: true,
        ingestedAt: true, updatedAt: true, job: { select: { projectId: true } },
      },
    });
    return rows.remap((m: { job: { projectId: string }; files: unknown; status: string } & Omit<IngestListRow, 'projectId' | 'files' | 'status'>) => ({
      id: m.id, jobId: m.jobId, leaseEpoch: m.leaseEpoch, projectId: m.job.projectId, status: m.status as IngestStatus, attempts: m.attempts,
      parserVersion: m.parserVersion, files: (m.files ?? {}) as Record<string, string>, error: m.error, ingestedAt: m.ingestedAt, updatedAt: m.updatedAt,
    }));
  }
}
