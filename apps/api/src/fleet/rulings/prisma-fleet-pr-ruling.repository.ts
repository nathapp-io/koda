import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { FleetPrRuling as RulingRow, PrismaClient } from '../../generated/prisma/client';
import { prNumberFor } from '../sync/pr-attribution.service';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import type { FleetPrRuling, IFleetPrRulingRepository, NewFleetPrRuling, PendingFixRuling, RulingJobTarget, RulingResultPatch, RulingTargetRepo } from './fleet-pr-ruling.domain';

/** US-014: the job's repo, reduced to what a ruling target needs (the preflight forge read included). */
const targetRepo = (repo: { id: string; provider: string; owner: string; name: string; host: string; githubInstallationId: bigint | null }): RulingTargetRepo =>
  ({ id: repo.id, provider: repo.provider, owner: repo.owner, name: repo.name, host: repo.host, githubInstallationId: repo.githubInstallationId });

/** The repository row a ruling target is projected off, as far as `prNumberFor` reads it. */
type PrNumberRepo = Pick<FleetRepoRef, 'provider' | 'owner' | 'name' | 'host'>;

/**
 * US-005: the stored provider column, normalized for `prNumberFor`: only `'gitlab'` selects the
 * merge-request parser, so a repo row holding anything else reads its URLs as a GitHub pull request.
 */
const prNumberRepo = (repo: { provider: string; owner: string; name: string; host: string }): PrNumberRepo =>
  ({ provider: repo.provider === 'gitlab' ? 'gitlab' : 'github', owner: repo.owner, name: repo.name, host: repo.host });

/** US-005: the URL suffix that narrows a RUN lookup to one merge request, per forge. */
const prUrlSuffix = (provider: string, prNumber: number): string =>
  provider === 'gitlab' ? `/merge_requests/${prNumber}` : `/pull/${prNumber}`;

/**
 * Review B1: the origin a repo's PR URLs must carry — its forge scheme, host and port, without the
 * path prefix a self-hosted instance is served below. `null` when the row's `host` is not a URL.
 */
const repoOrigin = (host: string): string | null => {
  try { return new URL(host).origin; } catch { return null; }
};

/**
 * Review B1: `prNumberFor` reads the URL path only, so a same-path URL on another forge host
 * (`https://gitlab.example.com/acme/app/pull/42`) would otherwise confirm as this repo's PR and a
 * newer foreign-host RUN could displace the correct one. A stored URL is only a candidate when its
 * origin is the row's own origin; a `host` that is not a URL vouches for no URL at all.
 */
const sameRepoOrigin = (repo: PrNumberRepo, url: string): boolean => {
  const expected = repoOrigin(repo.host);
  if (expected === null) return false;
  try { return new URL(url).origin === expected; } catch { return false; }
};

/** Resolve a PR only when both the configured forge origin and provider-specific path agree. */
const configuredPrNumber = (repo: PrNumberRepo, url: string): number | null =>
  sameRepoOrigin(repo, url) ? prNumberFor(repo, url) : null;

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
    const identity = await this.prisma.client.fleetJob.findFirst({
      where: { id: jobId, project: { slug, deletedAt: null } }, select: { repoId: true },
    });
    if (!identity) return null;
    // FOR UPDATE (not NO KEY UPDATE) fences new jobs through their repo foreign key.
    // Lock the existing repo jobs too: any one can gain/change a PR URL or become a RUN.
    // All ruling writers take this repo-first order; no caller needs to cooperate with an advisory lock.
    await this.prisma.client.$queryRaw`SELECT id FROM "FleetRepo" WHERE id = ${identity.repoId} FOR UPDATE`;
    await this.prisma.client.$queryRaw`SELECT COUNT(*) FROM (
      SELECT id FROM "FleetJob" WHERE "repoId" = ${identity.repoId} ORDER BY id FOR UPDATE
    ) AS locked_jobs`;
    // Job locks fence ruling inserts via their FK, but existing applied-state writers need row locks.
    await this.prisma.client.$queryRaw`SELECT COUNT(*) FROM (
      SELECT id FROM "FleetPrRuling" WHERE "jobId" = ${jobId} ORDER BY id FOR UPDATE
    ) AS locked_rulings`;
    const job = await this.prisma.client.fleetJob.findUnique({ where: { id: jobId }, include: { project: true, repo: true } });
    if (!job || job.repoId !== identity.repoId || job.project.slug !== slug || job.project.deletedAt !== null) return null;
    const workflow = job.workflow;
    const items = workflow && typeof workflow === 'object' && !Array.isArray(workflow) && Array.isArray(workflow.openItems) ? workflow.openItems : [];
    const openItems: { id: string; kind: string }[] = [];
    for (const item of items) {
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && typeof item.kind === 'string') openItems.push({ id: item.id, kind: item.kind });
    }
    const prNumber = job.resultPrUrl ? prNumberFor(prNumberRepo(job.repo), job.resultPrUrl) : null;
    return { projectId: job.projectId, repoId: job.repoId, prNumber, openItems, repo: targetRepo(job.repo) };
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
      prNumber: job.resultPrUrl ? prNumberFor(prNumberRepo(job.repo), job.resultPrUrl) : null, openItems,
      repo: targetRepo(job.repo) };
  }

  async latestRunForPr(repoId: string, prNumber: number): Promise<string | null> {
    const repo = await this.prisma.client.fleetRepo.findUnique({ where: { id: repoId } });
    if (!repo || (repo.provider !== 'github' && repo.provider !== 'gitlab')) return null;
    const ref = prNumberRepo(repo);
    // US-005: the pre-filter narrows to this forge's URL shape; `prNumberFor` confirms every match.
    // Include supported URL suffix variants because URL parsing strips query strings and fragments.
    // Review B1: the candidate's origin must also be this repo's, so another host's same-path URL
    // can neither be returned nor hide the correct run behind it.
    const suffix = prUrlSuffix(repo.provider, prNumber);
    const urlVariants = [
      { resultPrUrl: { endsWith: suffix } },
      { resultPrUrl: { endsWith: `${suffix}/` } },
      { resultPrUrl: { contains: `${suffix}?` } },
      { resultPrUrl: { contains: `${suffix}/?` } },
      { resultPrUrl: { contains: `${suffix}#` } },
      { resultPrUrl: { contains: `${suffix}/#` } },
    ];
    const pageSize = 100;
    for (let page = 0; page < 1000; page++) {
      const jobs = await this.prisma.client.fleetJob.findMany({
        where: { repoId, command: 'RUN', OR: urlVariants },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: pageSize, skip: page * pageSize,
        select: { id: true, resultPrUrl: true },
      });
      const match = jobs.find((job) => job.resultPrUrl && configuredPrNumber(ref, job.resultPrUrl) === prNumber);
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

  async pendingForFix(jobId: string): Promise<PendingFixRuling[]> {
    const rows = await this.prisma.client.fleetPrRuling.findMany({
      where: { jobId, state: 'pending' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
    });
    const agentIds = rows.filter((r) => r.actorType === 'AGENT').map((r) => r.actorId);
    const userIds = rows.filter((r) => r.actorType === 'USER').map((r) => r.actorId);
    const [agents, users] = await Promise.all([
      agentIds.length ? this.prisma.client.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, slug: true }, take: 100 }) : Promise.resolve([]),
      userIds.length ? this.prisma.client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true }, take: 100 }) : Promise.resolve([]),
    ]);
    return rows.map((r) => ({ ...this.toDomain(r), actorName: r.actorType === 'SYSTEM' ? r.actorId : (r.actorType === 'AGENT'
      ? agents.find((a) => a.id === r.actorId)?.slug : users.find((u) => u.id === r.actorId)?.name) ?? r.actorId }));
  }

  /** Called in ingest's transaction. Re-read identity here, without a JobsModule dependency. */
  async replaceOlderRuns(jobId: string): Promise<void> {
    const job = await this.prisma.client.fleetJob.findUnique({ where: { id: jobId }, include: { repo: true } });
    if (!job || job.command !== 'RUN' || !job.workflow || !job.resultPrUrl) return;
    const ref = prNumberRepo(job.repo);
    const prNumber = configuredPrNumber(ref, job.resultPrUrl);
    if (prNumber === null) return;
    await this.prisma.client.fleetPrRuling.updateMany({
      where: { repoId: job.repoId, prNumber, state: 'pending', job: { command: 'RUN', OR: [
        { createdAt: { lt: job.createdAt } }, { createdAt: job.createdAt, id: { lt: job.id } },
      ] } }, data: { state: 'replaced' },
    });
  }

  /** Atomic pending predicate fences re-rulings; only snapshot ids are eligible. In ingest's transaction. */
  async settlePending(id: string, repoId: string, patch: RulingResultPatch): Promise<{ jobId: string } | null> {
    const rows = await this.prisma.client.fleetPrRuling.updateManyAndReturn({
      where: { id, repoId, state: 'pending' }, data: patch, select: { jobId: true },
    });
    return rows[0] ?? null;
  }

  async runsForPr(repoId: string, prNumber: number): Promise<string[]> {
    const repo = await this.prisma.client.fleetRepo.findUnique({ where: { id: repoId } });
    if (!repo || (repo.provider !== 'github' && repo.provider !== 'gitlab')) return [];
    const ref = prNumberRepo(repo);
    const result: string[] = [];
    const pageSize = 100;
    for (let page = 0; page < 1000; page++) {
      const rows = await this.prisma.client.fleetJob.findMany({
        // prNumberFor owns URL normalization (including trailing slash, query and fragment).
        where: { repoId, command: 'RUN', resultPrUrl: { not: null } },
        select: { id: true, resultPrUrl: true }, orderBy: { id: 'asc' }, take: pageSize, skip: page * pageSize,
      });
      for (const row of rows) if (row.resultPrUrl && configuredPrNumber(ref, row.resultPrUrl) === prNumber) result.push(row.id);
      if (rows.length < pageSize) return result;
    }
    throw new Error('Fleet ruling ready RUN lookup exceeded page limit');
  }

  async replacePending(jobId: string, itemId: string): Promise<void> {
    await this.prisma.client.fleetPrRuling.updateMany({ where: { jobId, itemId, state: 'pending' }, data: { state: 'replaced' } });
  }
  async insert(data: NewFleetPrRuling): Promise<FleetPrRuling> {
    return this.toDomain(await this.prisma.client.fleetPrRuling.create({ data }));
  }
}
