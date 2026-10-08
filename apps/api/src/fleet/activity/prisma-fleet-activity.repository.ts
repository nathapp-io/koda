import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetActivityFilters, FleetActivityRecord, IFleetActivityRepository } from './domain/fleet-activity.domain';

@Injectable()
export class PrismaFleetActivityRepository implements IFleetActivityRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run, so records commit with the caller's writes. */
  private get db() {
    return this.prisma.client;
  }

  async create(row: Parameters<IFleetActivityRepository['create']>[0]): Promise<void> {
    await this.db.fleetActivity.create({ data: { ...row, payload: row.payload as Prisma.InputJsonValue } });
  }

  async findPage(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityRecord>> {
    const where: Prisma.FleetActivityWhereInput = {
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.projectIds ? { projectId: { in: [...filters.projectIds] } } : {}),
    };
    const rows = await Paginate(this.db.fleetActivity, page, { where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((m: FleetActivityRecord) => m);
  }

  async findMemberProjectIds(userId: string): Promise<string[]> {
    const rows = await this.db.projectMember.findMany({ where: { userId, project: { deletedAt: null } }, select: { projectId: true } });
    return rows.map((r) => r.projectId);
  }
}
