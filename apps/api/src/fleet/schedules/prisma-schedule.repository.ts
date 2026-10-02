import { Injectable } from '@nestjs/common';
import { JobSchedule as ScheduleRow, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { FleetJobState } from '../../common/enums';
import { ACTIVE_STATES } from '../jobs/job-state';
import {
  IScheduleRepository, NewSchedule, OwnerAccess, ScheduleActiveJob, ScheduleDisabledReason, SchedulePatch, ScheduleRecord,
} from './domain/schedule.domain';

const toSchedule = (r: ScheduleRow): ScheduleRecord => ({
  ...r,
  maxCostUsd: r.maxCostUsd.toString(),
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
      data: { ...data, maxCostUsd: new Prisma.Decimal(data.maxCostUsd), updatedById: data.createdById },
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

  async findOwnerAccess(projectId: string, userId: string): Promise<OwnerAccess> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { disabled: true, role: true } });
    if (!user) return { exists: false, disabled: false, globalRole: '', projectRole: null };
    const member = await this.db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { role: true } });
    return { exists: true, disabled: user.disabled, globalRole: user.role, projectRole: member?.role ?? null };
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
