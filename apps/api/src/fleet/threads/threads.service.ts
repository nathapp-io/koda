import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { SkillsService } from '../../skills/skills.service';
import { FLEET_REPO_REPOSITORY, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { CHAT_THREAD_REPOSITORY, type ChatMessageRecord, type ChatThreadRecord, type ChatThreadRepository } from './domain/chat-thread.domain';
import { validateCreateThread, type CreateThreadInput } from './thread-input';

@Injectable()
export class ThreadsService {
  constructor(
    @Inject(CHAT_THREAD_REPOSITORY) private readonly threads: ChatThreadRepository,
    @Inject(FLEET_REPO_REPOSITORY) private readonly repos: IFleetRepoRepository,
    private readonly skills: SkillsService,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
  ) {}

  async create(projectId: string, userId: string, input: CreateThreadInput): Promise<ChatThreadRecord> {
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    validateCreateThread(input, input.baseRef ?? 'main');
    const repo = await this.repos.findById(input.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const normalized = validateCreateThread(input, repo.defaultBranch);
    const skills = await this.skills.snapshotForProject(projectId);
    try {
      return await this.threads.create({ projectId, repoId: repo.id, baseRef: normalized.baseRef, feature: normalized.feature, title: normalized.title, createdById: userId, backend: normalized.backend, skills, maxCostUsd: normalized.maxCostUsd });
    } catch (error) {
      if (isUniqueViolation(error, 'repo_feature')) throw new ConflictAppException({ feature: normalized.feature }, 'threads.featureTaken');
      throw error;
    }
  }

  list(projectId: string, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]> { return this.threads.list(projectId, status, skip, take); }
  async get(projectId: string, id: string): Promise<ChatThreadRecord> {
    const result = await this.threads.get(projectId, id);
    if (!result) throw new NotFoundAppException({}, 'threads.notFound');
    return result;
  }
  async messages(projectId: string, id: string, afterSeq: number, limit: number): Promise<{ items: ChatMessageRecord[] }> {
    const thread = await this.get(projectId, id);
    return { items: await this.threads.messages(thread.id, afterSeq, limit) };
  }
}
