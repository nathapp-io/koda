import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ACTIVE_STATES } from '../jobs/job-state';
import type { AutoReviewPatch, FleetRepoRecord, IFleetRepoRepository } from './domain/fleet-repo.domain';

@Injectable()
export class PrismaFleetRepoRepository implements IFleetRepoRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findProject(slug: string) {
    return this.db.project.findFirst({ where: { slug, deletedAt: null }, select: { id: true, slug: true } });
  }

  private toDomain(row: Prisma.FleetRepoGetPayload<object>): FleetRepoRecord {
    return { ...row, autoReviewMaxCostUsd: row.autoReviewMaxCostUsd.toFixed(4),
      autoReviewEnabledByType: row.autoReviewEnabledByType === 'USER' || row.autoReviewEnabledByType === 'AGENT' ? row.autoReviewEnabledByType : null };
  }

  async create(data: Omit<FleetRepoRecord, 'id' | 'createdAt' | 'autoReview' | 'autoReviewProfiles' | 'autoReviewMaxCostUsd' | 'autoReviewEnabledById' | 'autoReviewEnabledByType' | 'autoReviewEnabledAt'>): Promise<FleetRepoRecord> {
    try {
      return this.toDomain(await this.db.fleetRepo.create({ data }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictAppException({}, 'fleet.repos');
      }
      throw error;
    }
  }

  async updateAutoReview(id: string, patch: AutoReviewPatch): Promise<FleetRepoRecord> {
    return this.toDomain(await this.db.fleetRepo.update({ where: { id }, data: patch }));
  }

  async findById(id: string): Promise<FleetRepoRecord | null> {
    const row = await this.db.fleetRepo.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  /** The project's anchor repo (S5b-R13): oldest `createdAt`, ties by smallest `id`. */
  async findAnchor(projectId: string): Promise<FleetRepoRecord | null> {
    const row = await this.db.fleetRepo.findFirst({ where: { projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return row ? this.toDomain(row) : null;
  }

  async findAutoReviewPage(limit: number): Promise<FleetRepoRecord[]> {
    const rows = await this.db.fleetRepo.findMany({
      where: { autoReview: true, provider: 'github', githubInstallationId: { not: null }, project: { deletedAt: null } },
      orderBy: { id: 'asc' }, take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>> {
    const where: Prisma.FleetRepoWhereInput = filters.projectId ? { projectId: filters.projectId } : {};
    const rows = await Paginate(this.db.fleetRepo, page, { where, orderBy: [{ owner: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    return rows.remap((m) => this.toDomain(m));
  }

  async delete(id: string): Promise<void> {
    await this.db.fleetRepo.delete({ where: { id } });
  }

  /**
   * The compare-and-set turn-off (auto-review spec, call 4). One statement, so a pass that read a stale repo
   * list cannot turn off a repo someone else has just re-enabled: the `autoReviewEnabledById` predicate fails
   * on the re-enabled row. Profiles and cost stay, so a later re-enable keeps the enabler's settings.
   */
  async disableAutoReviewIf(id: string, expectedEnablerId: string): Promise<boolean> {
    const changed = await this.db.fleetRepo.updateMany({
      where: { id, autoReview: true, autoReviewEnabledById: expectedEnablerId },
      data: { autoReview: false, autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null },
    });
    return changed.count === 1;
  }

  countUnfinishedJobs(repoId: string): Promise<number> {
    return this.db.fleetJob.count({ where: { repoId, state: { in: [...ACTIVE_STATES] } } });
  }

  async lockForDelete(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "FleetRepo" WHERE "id" = ${id} FOR UPDATE`;
  }
}
