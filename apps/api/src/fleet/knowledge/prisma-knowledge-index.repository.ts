import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { KnowledgeRepoFile as FileRow, KnowledgeRepoIndex as IndexRow, Prisma, PrismaClient } from '../../generated/prisma/client';
import type { RunOutcomeRow } from '../ingest/domain/bundle-ingest.domain';
import { PROJECT_CODE_LIMITS } from '../common/thread-jobs';
import { MAX_KNOWLEDGE_FILES } from './knowledge-allowlist';
import {
  IKnowledgeIndexRepository, KnowledgeFileState, KnowledgeFinishResult, KnowledgeIndexState, KnowledgeIndexStatus, KnowledgeJobInfo, KnowledgeRepoRef, KnowledgeRunOutcomes,
} from './knowledge-index.domain';

export { KNOWLEDGE_INDEX_REPOSITORY } from './knowledge-index.domain';

const MAX_GITHUB_REPOS = 500;
/** S5b 3c-2-D4: the caps of one `describeJobs` read — the jobs a search may name, and their fleet links. */
const MAX_DESCRIBED_JOBS = 200;
const MAX_DESCRIBED_LINKS = 1000;
/** S5b 3c-2-D4: the outcome fence reads the links the fleet wrote, never a ticket's own VCS link. */
const FLEET_LINK_SOURCE = 'fleet';
/** S5b 3c-2-D4: an ingest that succeeded — only those retire the outcomes of an earlier attempt. */
const INGESTED_STATUSES = ['done', 'partial'] as const;
/** S5b 3c-2-D6: the outcome files, in the order a pass writes them. */
const OUTCOME_KINDS = ['report', 'decisions'] as const;
const REPO_SELECT = { id: true, projectId: true, provider: true, owner: true, name: true, defaultBranch: true, githubInstallationId: true } as const;

const toRepo = (r: { id: string; projectId: string; provider: string; owner: string; name: string; defaultBranch: string; githubInstallationId: bigint | null }): KnowledgeRepoRef => ({
  ...r,
  provider: r.provider as KnowledgeRepoRef['provider'],
});

const toState = (r: IndexRow): KnowledgeIndexState => ({ ...r, status: r.status as KnowledgeIndexStatus });

const toFile = (r: FileRow): KnowledgeFileState => ({
  repoId: r.repoId, path: r.path, blobSha: r.blobSha, chunkCount: r.chunkCount, unembeddedCount: r.unembeddedCount,
});

/** Owns `KnowledgeRepoIndex`, `KnowledgeRepoFile` and the read of indexable repositories. Module-private. */
@Injectable()
export class PrismaKnowledgeIndexRepository implements IKnowledgeIndexRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findRepo(repoId: string): Promise<KnowledgeRepoRef | null> {
    const r = await this.db.fleetRepo.findUnique({ where: { id: repoId }, select: REPO_SELECT });
    return r ? toRepo(r) : null;
  }

  /** Same order and bound as `PrismaFleetJobRepository.findProjectRepos`: `createdAt`, then `id`. */
  async findProjectRepos(projectId: string): Promise<KnowledgeRepoRef[]> {
    const rows = await this.db.fleetRepo.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PROJECT_CODE_LIMITS.maxRepos + PROJECT_CODE_LIMITS.maxUnavailable,
      select: REPO_SELECT,
    });
    return rows.map(toRepo);
  }

  async findAllGithubRepos(): Promise<KnowledgeRepoRef[]> {
    const rows = await this.db.fleetRepo.findMany({
      where: { provider: 'github', githubInstallationId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_GITHUB_REPOS,
      select: REPO_SELECT,
    });
    return rows.map(toRepo);
  }

  async claim(repoId: string, projectId: string, now: Date, leaseMs: number): Promise<boolean> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    try {
      await this.db.knowledgeRepoIndex.create({
        data: { repoId, projectId, status: 'running', leaseUntil, startedAt: now },
      });
      return true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      // P2003: the repository was deleted under the pass; nothing to claim.
      if (error.code === 'P2003') return false;
      if (error.code !== 'P2002') throw error;
    }
    // The row exists: take it only when it is free or its lease has expired (compare-and-set on the lease).
    const taken = await this.db.knowledgeRepoIndex.updateMany({
      where: { repoId, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { status: 'running', leaseUntil, startedAt: now },
    });
    return taken.count === 1;
  }

  async renew(repoId: string, leaseUntil: Date, startedAt?: Date): Promise<boolean> {
    const renewed = await this.db.knowledgeRepoIndex.updateMany({
      where: { repoId, status: 'running', ...(startedAt ? { startedAt } : {}) },
      data: { leaseUntil },
    });
    return renewed.count === 1;
  }

  async finish(repoId: string, result: KnowledgeFinishResult): Promise<void> {
    const data = {
      status: result.status,
      ...(result.indexedSha !== undefined ? { indexedSha: result.indexedSha } : {}),
      ...(result.patternsKey !== undefined ? { patternsKey: result.patternsKey } : {}),
      fileCount: result.fileCount,
      chunkCount: result.chunkCount,
      unembeddedCount: result.unembeddedCount,
      skippedCount: result.skippedCount,
      lastError: result.lastError,
      leaseUntil: null,
      finishedAt: result.finishedAt,
    };
    await this.db.knowledgeRepoIndex.upsert({
      where: { repoId },
      create: { repoId, projectId: result.projectId, ...data },
      update: data,
    });
  }

  async listFiles(repoId: string): Promise<KnowledgeFileState[]> {
    // Enumerates every persisted state, paginated by `path`: an interrupted pass leaves the new files' rows
    // written and the obsolete files' rows not yet deleted, so a repository can temporarily hold more rows than
    // the 2000-file corpus cap. A capped read would hide the tail from the indexer's cleanup step and keep those
    // files' chunks searchable forever (US-004/AC-5); the cap belongs to corpus selection, not to bookkeeping.
    const rows: FileRow[] = [];
    let after: string | undefined;
    for (;;) {
      const page: FileRow[] = await this.db.knowledgeRepoFile.findMany({
        where: { repoId, ...(after === undefined ? {} : { path: { gt: after } }) },
        orderBy: { path: 'asc' },
        take: MAX_KNOWLEDGE_FILES,
      });
      rows.push(...page);
      if (page.length < MAX_KNOWLEDGE_FILES) return rows.map(toFile);
      after = page[page.length - 1].path;
    }
  }

  async upsertFile(file: KnowledgeFileState): Promise<void> {
    const { repoId, path, ...rest } = file;
    await this.db.knowledgeRepoFile.upsert({
      where: { repoId_path: { repoId, path } },
      create: { repoId, path, ...rest },
      update: rest,
    });
  }

  async deleteFile(repoId: string, path: string): Promise<void> {
    await this.db.knowledgeRepoFile.deleteMany({ where: { repoId, path } });
  }

  async listStates(projectId: string): Promise<KnowledgeIndexState[]> {
    const rows = await this.db.knowledgeRepoIndex.findMany({
      where: { projectId },
      orderBy: { repoId: 'asc' },
      take: PROJECT_CODE_LIMITS.maxRepos + PROJECT_CODE_LIMITS.maxUnavailable,
    });
    return rows.map(toState);
  }

  /**
   * US-002: the project's saved patterns. A row whose JSON is not an array of strings is treated as no row: the
   * selection must never be handed a value the parser would have rejected.
   */
  async findProjectPatterns(projectId: string): Promise<string[] | null> {
    const row = await this.db.knowledgeProjectPatterns.findUnique({ where: { projectId } });
    if (!row || !Array.isArray(row.patterns)) return null;
    return row.patterns.filter((pattern): pattern is string => typeof pattern === 'string');
  }

  /** US-002: one row per project; null deletes it, so the project falls back to the default corpus. */
  async saveProjectPatterns(projectId: string, patterns: string[] | null): Promise<void> {
    if (patterns === null) {
      await this.db.knowledgeProjectPatterns.deleteMany({ where: { projectId } });
      return;
    }
    await this.db.knowledgeProjectPatterns.upsert({
      where: { projectId },
      create: { projectId, patterns },
      update: { patterns },
    });
  }

  /**
   * S5b 3c-2-D4: reads the fleet tables directly — a recorded exception to the cross-module rule, because
   * `KnowledgeModule` cannot import `FleetJobsModule` (jobs imports tickets, and tickets imports this module).
   * Read-only, bounded and module-private, like the `FleetRepo` read of `findProjectRepos`.
   *
   * The epoch is the highest `leaseEpoch` a *successful* ingest wrote (`done` or `partial`): a failed ingest
   * never retires the outcomes of the attempt before it. The rows come back `report` first, the order the
   * bundle writes them and the outcome pass consumes them.
   */
  async findRunOutcomes(jobId: string): Promise<KnowledgeRunOutcomes | null> {
    const job = await this.db.fleetJob.findUnique({
      where: { id: jobId },
      select: {
        id: true, projectId: true, repoId: true, feature: true, resultSha: true,
        repo: { select: { owner: true, name: true } },
      },
    });
    if (!job) return null;
    const latest = await this.db.fleetBundleIngest.findFirst({
      where: { jobId, status: { in: [...INGESTED_STATUSES] } },
      orderBy: { leaseEpoch: 'desc' },
      take: 1,
      select: { leaseEpoch: true },
    });
    const rows = latest === null ? [] : await this.db.fleetRunOutcome.findMany({
      where: { jobId, leaseEpoch: latest.leaseEpoch },
      orderBy: { kind: 'asc' },
      // `@@unique([jobId, leaseEpoch, kind])` holds at most the two known kinds.
      take: 2,
      select: { kind: true, content: true },
    });
    return {
      job: {
        id: job.id, projectId: job.projectId, repoId: job.repoId, feature: job.feature,
        owner: job.repo.owner, name: job.repo.name, resultSha: job.resultSha,
      },
      outcomes: OUTCOME_KINDS
        .map(kind => rows.find(row => row.kind === kind))
        .filter((row): row is RunOutcomeRow => row !== undefined),
    };
  }

  /**
   * S5b 3c-2-D4: the current state of the given jobs, in two bounded queries rather than one per hit. Same
   * recorded exception as `findRunOutcomes`: read-only, bounded and module-private. Only the jobs of
   * `projectId` come back, so the caller drops an outcome hit whose job is a foreign or a deleted one (US-005),
   * and `prState` is the state of the job's most recently updated fleet link, the one the fleet PR sync writes.
   */
  async describeJobs(projectId: string, jobIds: string[]): Promise<KnowledgeJobInfo[]> {
    if (jobIds.length === 0) return [];
    const [jobs, links] = await Promise.all([
      this.db.fleetJob.findMany({
        where: { id: { in: jobIds }, projectId },
        take: MAX_DESCRIBED_JOBS,
        select: { id: true, repoId: true, feature: true, state: true, resultPrUrl: true },
      }),
      this.db.ticketLink.findMany({
        where: { jobId: { in: jobIds }, source: FLEET_LINK_SOURCE, prState: { not: null } },
        orderBy: [{ prUpdatedAt: 'desc' }, { id: 'asc' }],
        take: MAX_DESCRIBED_LINKS,
        select: { jobId: true, prState: true },
      }),
    ]);
    // The links arrive newest first, so the first link a job appears in is the PR state it is reported with.
    const prState = new Map<string, string>();
    for (const link of links) {
      if (link.jobId === null || link.prState === null || prState.has(link.jobId)) continue;
      prState.set(link.jobId, link.prState);
    }
    return jobs.map(job => ({
      jobId: job.id, repoId: job.repoId, feature: job.feature, state: job.state,
      prUrl: job.resultPrUrl, prState: prState.get(job.id) ?? null,
    }));
  }
}
