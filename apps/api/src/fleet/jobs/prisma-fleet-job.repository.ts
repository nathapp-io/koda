import { Injectable } from '@nestjs/common';
import { FleetCommand as FleetCommandRow, FleetJob as JobRow, Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { FleetCommandAckResult, FleetCommandType, FleetJobState, FleetJobKind } from '../../common/enums';
import type { RunnerCapabilities, BashMode } from '../common/protocol';
import { ACTIVE_STATES, RUNNER_HELD_STATES } from './job-state';
import type { ConfigJobResult } from '../common/config-jobs';
import {
  ActiveJobRef, DuplicateActiveJobError, FleetArtifactRecord, FleetCommandRecord, FleetJobEventRecord, FleetJobFilters,
  FleetJobPatch, FleetJobPostRun, FleetJobRecord, FleetJobStory, FleetRepoRef, IFleetJobRepository, NewFleetJob, PlacementRunnerRow,
} from './domain/fleet-job.domain';

const toJob = (r: JobRow): FleetJobRecord => ({
  ...r,
  command: r.command as FleetJobKind,
  state: r.state as FleetJobState,
  maxCostUsd: r.maxCostUsd.toString(),
  bashMode: r.bashMode as BashMode,
  costSpentUsd: r.costSpentUsd.toString(),
  costCarriedUsd: r.costCarriedUsd.toString(),
  stories: r.stories as unknown as FleetJobStory[] | null,
  postRun: r.postRun as unknown as FleetJobPostRun | null,
  configResult: r.configResult as unknown as ConfigJobResult | null,
});

const toCommand = (r: FleetCommandRow): FleetCommandRecord => ({ ...r, type: r.type as FleetCommandType });

@Injectable()
export class PrismaFleetJobRepository implements IFleetJobRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findRepo(repoId: string): Promise<FleetRepoRef | null> {
    const r = await this.db.fleetRepo.findUnique({
      where: { id: repoId },
      select: { id: true, projectId: true, provider: true, owner: true, name: true, defaultBranch: true, githubInstallationId: true },
    });
    return r ? { ...r, provider: r.provider as FleetRepoRef['provider'] } : null;
  }

  async createJob(data: NewFleetJob): Promise<FleetJobRecord> {
    try {
      return toJob(await this.db.fleetJob.create({ data: { ...data, maxCostUsd: new Prisma.Decimal(data.maxCostUsd) } }));
    } catch (error) {
      // The unique constraints a new row can hit are the active (repoId, feature) index and, for a scheduled job, the
      // one-QUEUED-job-per-schedule index (S1b §3.1); both mean an active job already exists.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicateActiveJobError();
      // A dispatch raced the delete of its repo (FK on FleetRepo) or, for a scheduled job, of its schedule (FK on
      // JobSchedule). Both answer 404; the schedule ticker treats it as a vanished template (plan D199).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') throw new NotFoundAppException({}, 'fleet.repos');
      throw error;
    }
  }

  async findActiveJobId(repoId: string, feature: string): Promise<string | null> {
    const row = await this.db.fleetJob.findFirst({
      where: { repoId, feature, state: { in: [...ACTIVE_STATES] } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async findById(id: string): Promise<FleetJobRecord | null> {
    const r = await this.db.fleetJob.findUnique({ where: { id } });
    return r ? toJob(r) : null;
  }

  async lockById(id: string, opts: { skipLocked?: boolean } = {}): Promise<FleetJobRecord | null> {
    const mode = opts.skipLocked ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql`FOR UPDATE`;
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "FleetJob" WHERE "id" = ${id} ${mode}`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findPage(f: FleetJobFilters, page: IPageOption): Promise<IPageResult<FleetJobRecord>> {
    const where: Prisma.FleetJobWhereInput = {
      projectId: f.projectId,
      ...(f.state ? { state: f.state } : {}),
      ...(f.repoId ? { repoId: f.repoId } : {}),
      ...(f.runnerId ? { runnerId: f.runnerId } : {}),
      ...(f.requestedById ? { requestedById: f.requestedById } : {}),
      ...(f.feature ? { feature: f.feature } : {}),
      ...(f.scheduleId ? { scheduleId: f.scheduleId } : {}),
    };
    const rows = await Paginate(this.db.fleetJob, page, { where, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((m: JobRow) => toJob(m));
  }

  async casAssign(jobId: string, runnerId: string, runnerBootId: string, now: Date): Promise<number | null> {
    // Prisma stores DateTime as UTC in `timestamp(3)`; bind the ISO string and cast, so the session
    // time zone can never shift it (a zone in the input is ignored for `timestamp without time zone`).
    const at = now.toISOString();
    const rows = await this.db.$queryRaw<Array<{ leaseEpoch: number }>>`
      UPDATE "FleetJob"
         SET "state" = 'ASSIGNED', "runnerId" = ${runnerId}, "runnerBootId" = ${runnerBootId},
             "leaseEpoch" = "leaseEpoch" + 1, "assignedAt" = CAST(${at} AS timestamp(3)),
             "ackedRunnerSeq" = 0, "updatedAt" = CAST(${at} AS timestamp(3))
       WHERE "id" = ${jobId} AND "state" = 'QUEUED'
   RETURNING "leaseEpoch"`;
    return rows[0]?.leaseEpoch ?? null;
  }

  async update(id: string, patch: FleetJobPatch): Promise<FleetJobRecord> {
    const { bumpEpoch, costSpentUsd, costCarriedUsd, progress, stories, postRun, configResult, ...rest } = patch;
    const data: Prisma.FleetJobUpdateInput = {
      ...rest,
      ...(costSpentUsd !== undefined ? { costSpentUsd: new Prisma.Decimal(costSpentUsd) } : {}),
      ...(costCarriedUsd !== undefined ? { costCarriedUsd: new Prisma.Decimal(costCarriedUsd) } : {}),
      ...(progress !== undefined ? { progress: progress === null ? Prisma.DbNull : (progress as Prisma.InputJsonValue) } : {}),
      ...(stories !== undefined ? { stories: stories === null ? Prisma.DbNull : (stories as unknown as Prisma.InputJsonValue) } : {}),
      ...(postRun !== undefined ? { postRun: postRun === null ? Prisma.DbNull : (postRun as unknown as Prisma.InputJsonValue) } : {}),
      ...(configResult !== undefined ? { configResult: configResult === null ? Prisma.DbNull : (configResult as unknown as Prisma.InputJsonValue) } : {}),
      ...(bumpEpoch ? { leaseEpoch: { increment: 1 } } : {}),
    };
    try {
      return toJob(await this.db.fleetJob.update({ where: { id }, data }));
    } catch (error) {
      // Requeue into a (repoId, feature) that has an active job (spec §5.3: "the partial index still applies").
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicateActiveJobError();
      throw error;
    }
  }

  async findQueuedIds(limit: number): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: FleetJobState.QUEUED }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findRunnerHeld(runnerId: string): Promise<FleetJobRecord[]> {
    const rows = await this.db.fleetJob.findMany({ where: { runnerId, state: { in: [...RUNNER_HELD_STATES] } }, orderBy: { id: 'asc' } });
    return rows.map(toJob);
  }

  async findSilentHeldIds(runnerSeenBefore: Date): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...RUNNER_HELD_STATES] }, runner: { lastSeenAt: { lt: runnerSeenBefore } } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async recordRunnerSync(runnerId: string, s: { now: Date; bootId: string; daemonVersion: string; protocolVersion: number; capabilities?: RunnerCapabilities }) {
    const before = await this.db.runner.findUnique({ where: { id: runnerId }, select: { bootId: true } });
    if (!before) return null;
    await this.db.runner.update({
      where: { id: runnerId },
      data: {
        lastSeenAt: s.now, bootId: s.bootId, daemonVersion: s.daemonVersion, protocolVersion: s.protocolVersion,
        // D131: a new boot id is a daemon restart; the same boot id keeps the recorded start.
        ...(before.bootId !== s.bootId ? { bootedAt: s.now } : {}),
        ...(s.capabilities ? { capabilities: s.capabilities as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    return { previousBootId: before.bootId };
  }

  async findPlacementRunners(ids?: readonly string[]): Promise<PlacementRunnerRow[]> {
    const rows = await this.db.runner.findMany({
      where: ids ? { id: { in: [...ids] } } : {},
      orderBy: { id: 'asc' },
      select: { id: true, name: true, enabled: true, lastSeenAt: true, labels: true, capacity: true, capabilities: true, bootId: true },
    });
    // Stored capabilities were validated by parseCapabilities at enroll/sync time.
    return rows.map((r) => ({ ...r, capabilities: r.capabilities as unknown as RunnerCapabilities }));
  }

  async lockRunners(ids?: readonly string[]): Promise<string[]> {
    if (ids && ids.length === 0) return [];
    const filter = ids ? Prisma.sql`WHERE "id" IN (${Prisma.join([...ids])})` : Prisma.empty;
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Runner" ${filter} ORDER BY "id" FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  async findActiveLoads(runnerIds: readonly string[]): Promise<ActiveJobRef[]> {
    if (runnerIds.length === 0) return [];
    const rows = await this.db.fleetJob.findMany({
      where: { runnerId: { in: [...runnerIds] }, state: { in: [...RUNNER_HELD_STATES] } },
      select: { runnerId: true, repoId: true },
    });
    return rows.map((r) => ({ runnerId: r.runnerId as string, repoId: r.repoId }));
  }

  /**
   * Append a server or runner event. **Must be called inside `txManager.run` while the
   * caller holds the job's row lock** (`lockById` with `FOR UPDATE`). The increment of
   * `eventSeq` is two queries and is serialised by that lock; outside the lock the
   * @@unique([jobId, seq]) index would surface duplicate seq values as P2002.
   * Plan D2 / review 2b TYPE-2 maps the runnerSeq-side P2002 to a no-op so the caller
   * still makes progress on a same-`(jobId, leaseEpoch, runnerSeq)` insert (a retry
   * whose prior sync was interrupted between the server-side read and write).
   */
  async appendEvent(jobId: string, e: { leaseEpoch: number; runnerSeq: number | null; type: string; payload: unknown }): Promise<FleetJobEventRecord> {
    const { eventSeq } = await this.db.fleetJob.update({ where: { id: jobId }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    try {
      return await this.db.fleetJobEvent.create({
        data: { jobId, seq: eventSeq, leaseEpoch: e.leaseEpoch, runnerSeq: e.runnerSeq, type: e.type, payload: e.payload as Prisma.InputJsonValue },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && e.runnerSeq !== null) {
        const existing = await this.db.fleetJobEvent.findUnique({
          where: { jobId_leaseEpoch_runnerSeq: { jobId, leaseEpoch: e.leaseEpoch, runnerSeq: e.runnerSeq } },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  findRunnerEvents(jobId: string, leaseEpoch: number, runnerSeqs: readonly number[]): Promise<FleetJobEventRecord[]> {
    return this.db.fleetJobEvent.findMany({ where: { jobId, leaseEpoch, runnerSeq: { in: [...runnerSeqs] } }, orderBy: { runnerSeq: 'asc' } });
  }

  findRunnerEventsAfter(jobId: string, leaseEpoch: number, afterRunnerSeq: number): Promise<FleetJobEventRecord[]> {
    return this.db.fleetJobEvent.findMany({ where: { jobId, leaseEpoch, runnerSeq: { gt: afterRunnerSeq } }, orderBy: { runnerSeq: 'asc' } });
  }

  async findEventPage(jobId: string, page: IPageOption): Promise<IPageResult<FleetJobEventRecord>> {
    const rows = await Paginate(this.db.fleetJobEvent, page, { where: { jobId }, orderBy: [{ seq: 'asc' }] });
    return rows.remap((m: FleetJobEventRecord) => m);
  }

  async createCommand(c: { runnerId: string; jobId: string; type: FleetCommandType; leaseEpoch: number; payload: object }): Promise<FleetCommandRecord> {
    return toCommand(await this.db.fleetCommand.create({ data: { ...c, payload: c.payload as Prisma.InputJsonValue } }));
  }

  async findPendingCommands(runnerId: string): Promise<FleetCommandRecord[]> {
    const rows = await this.db.fleetCommand.findMany({ where: { runnerId, ackedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toCommand);
  }

  async markDelivered(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db.fleetCommand.updateMany({ where: { id: { in: [...ids] }, deliveredAt: null }, data: { deliveredAt: now } });
  }

  async findCommand(id: string): Promise<FleetCommandRecord | null> {
    const r = await this.db.fleetCommand.findUnique({ where: { id } });
    return r ? toCommand(r) : null;
  }

  async ackCommand(id: string, result: string, now: Date): Promise<void> {
    await this.db.fleetCommand.updateMany({ where: { id, ackedAt: null }, data: { ackedAt: now, ackResult: result } });
  }

  async findPendingCommand(f: { jobId: string; type: FleetCommandType; runnerId?: string; leaseEpoch?: number }): Promise<FleetCommandRecord | null> {
    const r = await this.db.fleetCommand.findFirst({
      where: {
        jobId: f.jobId, type: f.type, ackedAt: null,
        ...(f.runnerId ? { runnerId: f.runnerId } : {}),
        ...(f.leaseEpoch !== undefined ? { leaseEpoch: f.leaseEpoch } : {}),
      },
    });
    return r ? toCommand(r) : null;
  }

  async withdrawPendingCommands(jobId: string, now: Date, opts: { types?: readonly FleetCommandType[] } = {}): Promise<number> {
    const type = opts.types ? { in: [...opts.types] } : { not: FleetCommandType.ABANDON };
    const { count } = await this.db.fleetCommand.updateMany({
      where: { jobId, ackedAt: null, type },
      data: { ackedAt: now, ackResult: FleetCommandAckResult.WITHDRAWN },
    });
    return count;
  }

  upsertArtifact(a: Omit<FleetArtifactRecord, 'id' | 'createdAt' | 'expiredAt'>): Promise<FleetArtifactRecord> {
    return this.db.fleetJobArtifact.upsert({
      where: { jobId_kind_leaseEpoch: { jobId: a.jobId, kind: a.kind, leaseEpoch: a.leaseEpoch } },
      create: a,
      update: { storageKey: a.storageKey, sizeBytes: a.sizeBytes, sha256: a.sha256, createdAt: new Date() },
    });
  }

  findArtifact(jobId: string, kind: string, leaseEpoch: number): Promise<FleetArtifactRecord | null> {
    return this.db.fleetJobArtifact.findUnique({ where: { jobId_kind_leaseEpoch: { jobId, kind, leaseEpoch } } });
  }

  findLatestArtifact(jobId: string, kind: string, opts: { includeExpired?: boolean } = {}): Promise<FleetArtifactRecord | null> {
    return this.db.fleetJobArtifact.findFirst({
      where: { jobId, kind, ...(opts.includeExpired ? {} : { expiredAt: null }) },
      orderBy: { leaseEpoch: 'desc' },
    });
  }

  async claimAttribution(jobId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.fleetJob.updateMany({ where: { id: jobId, attributedAt: null }, data: { attributedAt: now } });
    return count === 1;
  }

  /** Name only: the value lands in a PR/MR comment, possibly on a public repo, so never the email. */
  async findUserDisplayName(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? null;
  }

  async copyConfigResult(jobId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "FleetConfigEdit" e SET "result" = j."configResult"
        FROM "FleetJob" j
       WHERE j."id" = ${jobId} AND e."jobId" = j."id"`;
  }
}
