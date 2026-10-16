import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { KnowledgeRepoFile as FileRow, KnowledgeRepoIndex as IndexRow, Prisma, PrismaClient } from '../../generated/prisma/client';
import { PROJECT_CODE_LIMITS } from '../common/thread-jobs';
import { MAX_KNOWLEDGE_FILES } from './knowledge-allowlist';
import {
  IKnowledgeIndexRepository, KnowledgeFileState, KnowledgeFinishResult, KnowledgeIndexState, KnowledgeIndexStatus, KnowledgeRepoRef,
} from './knowledge-index.domain';

export { KNOWLEDGE_INDEX_REPOSITORY } from './knowledge-index.domain';

const MAX_GITHUB_REPOS = 500;
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

  async renew(repoId: string, leaseUntil: Date): Promise<boolean> {
    const renewed = await this.db.knowledgeRepoIndex.updateMany({
      where: { repoId, status: 'running' },
      data: { leaseUntil },
    });
    return renewed.count === 1;
  }

  async finish(repoId: string, result: KnowledgeFinishResult): Promise<void> {
    const data = {
      status: result.status,
      ...(result.indexedSha !== undefined ? { indexedSha: result.indexedSha } : {}),
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
    const rows = await this.db.knowledgeRepoFile.findMany({ where: { repoId }, orderBy: { path: 'asc' }, take: MAX_KNOWLEDGE_FILES });
    return rows.map(toFile);
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
}
