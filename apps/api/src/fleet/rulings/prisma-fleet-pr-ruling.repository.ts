import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { FleetPrRuling as RulingRow, PrismaClient } from '../../generated/prisma/client';
import { prNumberFor } from '../sync/pr-attribution.service';
import type { FleetPrRuling, IFleetPrRulingRepository, NewFleetPrRuling, RulingJobTarget } from './fleet-pr-ruling.domain';

@Injectable()
export class PrismaFleetPrRulingRepository extends AbstractPrismaRepository<FleetPrRuling, RulingRow, string> implements IFleetPrRulingRepository {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }
  protected modelDelegate(client: unknown): PrismaModelDelegate<RulingRow, string> {
    return (client as Record<string, unknown>).fleetPrRuling as PrismaModelDelegate<RulingRow, string>;
  }
  protected toDomain(row: RulingRow): FleetPrRuling {
    return { ...row, disposition: row.disposition as FleetPrRuling['disposition'], state: row.state as FleetPrRuling['state'], actorType: row.actorType as FleetPrRuling['actorType'] };
  }
  protected toPersistenceCreate(row: FleetPrRuling) { return { ...row }; }
  protected toPersistenceUpdate(row: Partial<FleetPrRuling>) { return { ...row }; }

  /** Own job read avoids importing FleetJobsModule, even when Jobs later imports Rulings. */
  async lockTarget(slug: string, jobId: string): Promise<RulingJobTarget | null> {
    await this.prisma.client.$queryRaw`SELECT id FROM "FleetJob" WHERE id = ${jobId} FOR UPDATE`;
    const job = await this.prisma.client.fleetJob.findUnique({ where: { id: jobId }, include: { project: true, repo: true } });
    if (!job || job.project.slug !== slug || job.project.deletedAt !== null || job.command !== 'RUN') return null;
    const workflow = job.workflow;
    const items = workflow && typeof workflow === 'object' && !Array.isArray(workflow) && Array.isArray(workflow.openItems) ? workflow.openItems : [];
    const openItems: { id: string; kind: string }[] = [];
    for (const item of items) {
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && typeof item.kind === 'string') openItems.push({ id: item.id, kind: item.kind });
    }
    const prNumber = job.repo.provider === 'github' && job.resultPrUrl ? prNumberFor({ ...job.repo, provider: 'github' }, job.resultPrUrl) : null;
    return { projectId: job.projectId, repoId: job.repoId, prNumber, openItems };
  }
  async findTarget(projectId: string, jobId: string) {
    const job = await this.prisma.client.fleetJob.findFirst({ where: { id: jobId, projectId, project: { deletedAt: null } }, include: { repo: true } });
    if (!job) return null;
    const workflow = job.workflow && typeof job.workflow === 'object' && !Array.isArray(job.workflow) ? job.workflow : {};
    const openItems: { id: string; kind: string }[] = [];
    for (const item of Array.isArray(workflow.openItems) ? workflow.openItems : []) {
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && typeof item.kind === 'string') openItems.push({ id: item.id, kind: item.kind });
    }
    return { projectId, repoId: job.repoId, command: job.command, outcome: typeof workflow.outcome === 'string' ? workflow.outcome : null,
      prNumber: job.repo.provider === 'github' && job.resultPrUrl ? prNumberFor({ ...job.repo, provider: 'github' }, job.resultPrUrl) : null, openItems };
  }

  async latestRunForPr(repoId: string, prNumber: number): Promise<string | null> {
    const repo = await this.prisma.client.fleetRepo.findUnique({ where: { id: repoId } });
    if (!repo || repo.provider !== 'github') return null;
    const pageSize = 100;
    for (let page = 0; page < 1000; page++) {
      const jobs = await this.prisma.client.fleetJob.findMany({
        where: { repoId, command: 'RUN', resultPrUrl: { endsWith: `/pull/${prNumber}` } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: pageSize, skip: page * pageSize,
        select: { id: true, resultPrUrl: true },
      });
      const match = jobs.find((job) => job.resultPrUrl && prNumberFor({ ...repo, provider: 'github' }, job.resultPrUrl) === prNumber);
      if (match) return match.id;
      if (jobs.length < pageSize) return null;
    }
    throw new Error('Fleet ruling RUN lookup exceeded page limit');
  }

  async latestRuling(jobId: string, itemId: string): Promise<FleetPrRuling | null> {
    const row = await this.prisma.client.fleetPrRuling.findFirst({ where: { jobId, itemId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return row ? this.toDomain(row) : null;
  }

  async list(jobId: string): Promise<FleetPrRuling[]> {
    const result: FleetPrRuling[] = [];
    const pageSize = 1000;
    for (let page = 0; page < 1000; page++) {
      const rows = await this.prisma.client.fleetPrRuling.findMany({ where: { jobId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: pageSize, skip: page * pageSize });
      result.push(...rows.map((row) => this.toDomain(row)));
      if (rows.length < pageSize) return result;
    }
    throw new Error('Fleet ruling list exceeded page limit');
  }

  async replacePending(jobId: string, itemId: string): Promise<void> {
    await this.prisma.client.fleetPrRuling.updateMany({ where: { jobId, itemId, state: 'pending' }, data: { state: 'replaced' } });
  }
  async insert(data: NewFleetPrRuling): Promise<FleetPrRuling> {
    return this.toDomain(await this.prisma.client.fleetPrRuling.create({ data }));
  }
}
