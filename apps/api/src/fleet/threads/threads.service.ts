import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { SkillsService } from '../../skills/skills.service';
import { FLEET_REPO_REPOSITORY, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { CHAT_THREAD_REPOSITORY, type ChatMessageRecord, type ChatThreadRecord, type ChatThreadRepository } from './domain/chat-thread.domain';
import { validateCreateThread, type CreateThreadInput } from './thread-input';
import type { AnswerQuestionDto, SendMessageDto } from './dto/thread.dto';
import { FleetCommandType } from '../../common/enums';
import { FleetJobsService } from '../jobs/fleet-jobs.service';

@Injectable()
export class ThreadsService {
  constructor(
    @Inject(CHAT_THREAD_REPOSITORY) private readonly threads: ChatThreadRepository,
    @Inject(FLEET_REPO_REPOSITORY) private readonly repos: IFleetRepoRepository,
    private readonly skills: SkillsService,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
    private readonly fleetJobs: FleetJobsService,
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

  async updateCap(projectId: string, threadId: string, userId: string, value: unknown): Promise<ChatThreadRecord> {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.0001 || value > 10000 || !/^\d+(?:\.\d{1,4})?$/.test(String(value))) throw new ValidationAppException({ reason: 'maxCostUsd' }, 'threads.input');
    return this.threads.updateCap(projectId, threadId, userId, String(value));
  }

  stop(projectId: string, threadId: string, userId: string): Promise<void> {
    return this.threads.command(projectId, threadId, userId, FleetCommandType.THREAD_STOP_TURN, {});
  }

  endSession(projectId: string, threadId: string, userId: string): Promise<void> {
    return this.threads.command(projectId, threadId, userId, FleetCommandType.THREAD_CLOSE, {});
  }

  async answer(projectId: string, threadId: string, userId: string, input: AnswerQuestionDto): Promise<void> {
    if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 128 || typeof input.text !== 'string' || input.text.length < 1 || Buffer.byteLength(input.text, 'utf8') > 32768) throw new ValidationAppException({ reason: 'answer' }, 'threads.input');
    return this.threads.command(projectId, threadId, userId, FleetCommandType.THREAD_ANSWER, input);
  }

  async archive(projectId: string, threadId: string, userId: string, canArchive: boolean): Promise<void> {
    const jobId = await this.threads.archive(projectId, threadId, userId, canArchive);
    if (!jobId) return;
    try { await this.fleetJobs.cancel(userId, projectId, jobId, true); }
    catch (error) {
      if (!(error instanceof ConflictAppException)) throw error;
      // The terminal transition may win after archive commits.
    }
  }

  archivedThreadIds(runnerId: string): Promise<string[]> { return this.threads.archivedThreadIds(runnerId); }

  async sendMessage(projectId: string, threadId: string, userId: string, input: SendMessageDto): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }> {
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    if (typeof input.text !== 'string' || input.text.length === 0 || Buffer.byteLength(input.text, 'utf8') > 32768 ||
        typeof input.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.clientMessageId)) {
      throw new ValidationAppException({ reason: 'message' }, 'threads.input');
    }
    return this.threads.sendMessage({ projectId, threadId, userId, text: input.text, clientMessageId: input.clientMessageId });
  }
}
