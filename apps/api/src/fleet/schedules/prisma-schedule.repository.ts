import { Injectable } from '@nestjs/common';
import { JobSchedule as ScheduleRow, Prisma, PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { FleetJobState } from '../../common/enums';
import type { PrincipalRef } from '../../permissions/permissions.types';
import type { BashMode } from '../common/protocol';
import { ACTIVE_STATES } from '../jobs/job-state';
import {
  IScheduleRepository, NewSchedule, OwnerAccess, ScheduleActiveJob, ScheduleDisabledReason, SchedulePatch, ScheduleRecord,
} from './domain/schedule.domain';

const toSchedule = (r: ScheduleRow): ScheduleRecord => ({
  ...r,
  createdByType: r.createdByType as 'USER' | 'AGENT',
  maxCostUsd: r.maxCostUsd.toString(),
  bashMode: r.bashMode as BashMode,
  disabledReason: r.disabledReason as ScheduleDisabledReason | null,
});

@Injectable()
export class PrismaScheduleRepository implements IScheduleRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findById(id: string): Promise<ScheduleRecord | null> {
    const r = await this.db.jobSchedule.findUnique({ where: { id } });
    return r ? toSchedule(r) : null;
  }

  async lockById(id: string): Promise<ScheduleRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "JobSchedule" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findByProject(projectId: string): Promise<ScheduleRecord[]> {
    const rows = await this.db.jobSchedule.findMany({ where: { projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toSchedule);
  }

  async findDue(now: Date, limit: number): Promise<ScheduleRecord[]> {
    const rows = await this.db.jobSchedule.findMany({
      where: { enabled: true, nextFireAt: { lte: now }, project: { deletedAt: null } },
      orderBy: [{ nextFireAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toSchedule);
  }

  async create(data: NewSchedule): Promise<ScheduleRecord> {
    const row = await this.db.jobSchedule.create({
      // US-002: a schedule with no creator type in its input was created by a user (every caller before agents could schedule).
      data: { ...data, createdByType: data.createdByType ?? 'USER', maxCostUsd: new Prisma.Decimal(data.maxCostUsd), updatedById: data.createdById },
    });
    return toSchedule(row);
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleRecord> {
    const { maxCostUsd, ...rest } = patch;
    const data: Prisma.JobScheduleUpdateInput = {
      ...rest,
      ...(maxCostUsd !== undefined ? { maxCostUsd: new Prisma.Decimal(maxCostUsd) } : {}),
    };
    return toSchedule(await this.db.jobSchedule.update({ where: { id }, data }));
  }

  async delete(id: string): Promise<void> {
    // Plan D194: lock order is job row, then schedule row. Detaching first keeps the FK's SET NULL from doing it the other way round.
    // deleteMany: a schedule another request just deleted is not an error.
    await this.db.fleetJob.updateMany({ where: { scheduleId: id }, data: { scheduleId: null } });
    await this.db.jobSchedule.deleteMany({ where: { id } });
  }

  async claimFire(id: string, expectedNextFireAt: Date, nextFireAt: Date, now: Date): Promise<boolean> {
    const claimed = await this.db.jobSchedule.updateMany({
      where: { id, enabled: true, nextFireAt: expectedNextFireAt },
      data: { nextFireAt, lastFiredAt: now },
    });
    return claimed.count === 1;
  }

  async findActiveJob(scheduleId: string): Promise<ScheduleActiveJob | null> {
    const row = await this.db.fleetJob.findFirst({
      where: { scheduleId, state: { in: [...ACTIVE_STATES] } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true },
    });
    return row ? { id: row.id, state: row.state as FleetJobState } : null;
  }

  async coalesceIntoQueued(scheduleId: string): Promise<string | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE "FleetJob" SET "coalescedCount" = "coalescedCount" + 1
       WHERE "scheduleId" = ${scheduleId} AND "state" = 'QUEUED'
   RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  async claimCounted(jobId: string, now: Date): Promise<boolean> {
    const claimed = await this.db.fleetJob.updateMany({ where: { id: jobId, scheduleCountedAt: null }, data: { scheduleCountedAt: now } });
    return claimed.count === 1;
  }

  /**
   * S1b §3.2 / plan D201, permissions P1d US-005: existence only, read from the owner's own table. A
   * USER exists when its `User` row does and is disabled when `User.disabled`; an AGENT exists when its
   * `Agent` row does and is never disabled (a PAUSED agent keeps its schedules; status is liveness,
   * not access). The permission itself is the owner's effective keys, read by `dispatchFresh`/`enable`.
   * Nothing is cached.
   */
  async findOwnerAccess(_projectId: string, owner: PrincipalRef): Promise<OwnerAccess> {
    if (owner.type === 'AGENT') {
      const agent = await this.db.agent.findUnique({ where: { id: owner.id }, select: { id: true } });
      return { exists: agent !== null, disabled: false };
    }
    const user = await this.db.user.findUnique({ where: { id: owner.id }, select: { disabled: true } });
    return user === null ? { exists: false, disabled: false } : { exists: true, disabled: user.disabled };
  }

  async sumCostBySchedule(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.fleetJob.groupBy({
      by: ['scheduleId'],
      where: { scheduleId: { in: [...ids] } },
      _sum: { costSpentUsd: true, costCarriedUsd: true },
    });
    return new Map(rows.flatMap((r): Array<[string, string]> =>
      r.scheduleId ? [[r.scheduleId, new Prisma.Decimal(r._sum.costSpentUsd ?? 0).add(r._sum.costCarriedUsd ?? 0).toFixed(4)]] : []));
  }
}
