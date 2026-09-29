import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ACTIVE_STATES } from '../jobs/job-state';
import type { FleetRepoRecord, IFleetRepoRepository } from './domain/fleet-repo.domain';

@Injectable()
export class PrismaFleetRepoRepository implements IFleetRepoRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findProject(slug: string) {
    return this.db.project.findFirst({ where: { slug, deletedAt: null }, select: { id: true, slug: true } });
  }

  async create(data: Omit<FleetRepoRecord, 'id' | 'createdAt'>): Promise<FleetRepoRecord> {
    try {
      return await this.db.fleetRepo.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictAppException({}, 'fleet.repos');
      }
      throw error;
    }
  }

  findById(id: string) {
    return this.db.fleetRepo.findUnique({ where: { id } });
  }

  async findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>> {
    const where: Prisma.FleetRepoWhereInput = filters.projectId ? { projectId: filters.projectId } : {};
    const rows = await Paginate(this.db.fleetRepo, page, { where, orderBy: [{ owner: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    return rows.remap((m: FleetRepoRecord) => m);
  }

  async delete(id: string): Promise<void> {
    await this.db.fleetRepo.delete({ where: { id } });
  }

  countUnfinishedJobs(repoId: string): Promise<number> {
    return this.db.fleetJob.count({ where: { repoId, state: { in: [...ACTIVE_STATES] } } });
  }

  async lockForDelete(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "FleetRepo" WHERE "id" = ${id} FOR UPDATE`;
  }
}
