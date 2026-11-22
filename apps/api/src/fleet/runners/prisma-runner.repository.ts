import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ACTIVE_STATES } from '../jobs/job-state';
import type { EnrollmentRecord, IRunnerRepository, NewRunner, RunnerPatch, RunnerRecord } from './domain/runner.domain';

const RUNNER_SELECT = {
  id: true, name: true, os: true, arch: true, labels: true, capacity: true, threadCapacity: true, capabilities: true,
  daemonVersion: true, protocolVersion: true, bootId: true, bootedAt: true, enabled: true, lastSeenAt: true,
  createdById: true, createdAt: true, updatedAt: true,
} as const; // never selects apiKeyHash

@Injectable()
export class PrismaRunnerRepository implements IRunnerRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  createEnrollment(data: { tokenHash: string; labels: string[]; expiresAt: Date; createdById: string }): Promise<EnrollmentRecord> {
    return this.db.runnerEnrollment.create({
      data,
      select: { id: true, labels: true, expiresAt: true, usedAt: true, runnerId: true, createdById: true, createdAt: true },
    });
  }

  async findEnrollmentPage(page: IPageOption): Promise<IPageResult<EnrollmentRecord>> {
    const rows = await Paginate(this.db.runnerEnrollment, page, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, labels: true, expiresAt: true, usedAt: true, runnerId: true, createdById: true, createdAt: true },
    });
    return rows.remap((m: EnrollmentRecord) => m);
  }

  async consumeEnrollment(tokenHash: string, now: Date) {
    const { count } = await this.db.runnerEnrollment.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return null;
    return this.db.runnerEnrollment.findUnique({ where: { tokenHash }, select: { id: true, labels: true, createdById: true } });
  }

  async deleteSpentEnrollmentsBefore(before: Date): Promise<number> {
    const { count } = await this.db.runnerEnrollment.deleteMany({
      where: { OR: [{ usedAt: { lt: before } }, { usedAt: null, expiresAt: { lt: before } }] },
    });
    return count;
  }

  async linkEnrollment(enrollmentId: string, runnerId: string): Promise<void> {
    await this.db.runnerEnrollment.update({ where: { id: enrollmentId }, data: { runnerId } });
  }

  async createRunner(data: NewRunner): Promise<RunnerRecord> {
    try {
      return await this.db.runner.create({
        data: { ...data, capabilities: data.capabilities as unknown as Prisma.InputJsonValue },
        select: RUNNER_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictAppException({}, 'fleet.runners');
      }
      throw error;
    }
  }

  findRunnerById(id: string): Promise<RunnerRecord | null> {
    return this.db.runner.findUnique({ where: { id }, select: RUNNER_SELECT });
  }

  async findRunnerPage(page: IPageOption): Promise<IPageResult<RunnerRecord>> {
    const rows = await Paginate(this.db.runner, page, { orderBy: [{ name: 'asc' }, { id: 'asc' }], select: RUNNER_SELECT });
    return rows.remap((m: RunnerRecord) => m);
  }

  updateRunner(id: string, patch: RunnerPatch): Promise<RunnerRecord> {
    return this.db.runner.update({ where: { id }, data: patch, select: RUNNER_SELECT });
  }

  async deleteRunner(id: string): Promise<void> {
    await this.db.runner.delete({ where: { id } });
  }

  /** US-005: one conditional UPDATE, so a request that raced a delete reports no runner. */
  async requestReprobe(id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.runner.updateMany({ where: { id }, data: { reprobeRequestedAt: now } });
    return count === 1;
  }

  countUnfinishedJobs(runnerId: string): Promise<number> {
    return this.db.fleetJob.count({ where: { OR: [{ runnerId }, { pinnedRunnerId: runnerId }], state: { in: [...ACTIVE_STATES] } } });
  }

  /**
   * Review B4: an edit takes the weaker `FOR NO KEY UPDATE` mode. It still conflicts with placement's `FOR UPDATE`
   * (so an `enabled` read here is serialised against placement), but it does not conflict with the `FOR KEY SHARE`
   * lock a concurrent cancellation takes on this row when its CANCEL command insert checks the runner foreign key —
   * `FOR UPDATE` here would deadlock: this transaction waits for the job row the cancellation holds, and the
   * cancellation waits for the key-share lock this transaction's `FOR UPDATE` blocks.
   */
  async lockForNoKeyUpdate(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "Runner" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  }

  /** Deletion keeps the strongest mode: nothing may reference the row while it goes away. */
  async lockForUpdate(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "Runner" WHERE "id" = ${id} FOR UPDATE`;
  }
}
