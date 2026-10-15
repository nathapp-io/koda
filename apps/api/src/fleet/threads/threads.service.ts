import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { SkillsService } from '../../skills/skills.service';
import { FLEET_REPO_REPOSITORY, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { CHAT_THREAD_REPOSITORY, repoThreadFields, type ChatMessageRecord, type ChatThreadDetail, type ChatThreadRecord, type ChatThreadRepository } from './domain/chat-thread.domain';
import { isMaxCostUsd, validateCreateThread, type CreateThreadInput } from './thread-input';
import { ProjectBriefService } from './project-brief.service';
import type { AnswerQuestionDto, SendMessageDto } from './dto/thread.dto';
import type { PlanThreadDto, RunThreadDto } from './dto/thread-handoff.dto';
import { THREAD_HANDOFF_DEFAULT_MAX_COST_USD } from './thread-handoff';
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
    private readonly projectBrief: ProjectBriefService,
  ) {}

  async create(projectId: string, userId: string, input: CreateThreadInput): Promise<ChatThreadRecord> {
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    const normalized = validateCreateThread(input, input.baseRef ?? 'main');
    // S5b-R3: a PROJECT thread has no repo, worktree or feature. The anchor repo is bookkeeping only (S5b-R13).
    if (normalized.kind === 'PROJECT') {
      const anchor = await this.repos.findAnchor(projectId);
      if (!anchor) throw new ConflictAppException({}, 'threads.noFleetRepo');
      const skills = await this.skills.snapshotForProject(projectId);
      return this.threads.create({ kind: 'PROJECT', projectId, repoId: null, baseRef: null, feature: null, title: normalized.title, createdById: userId, backend: normalized.backend, skills, maxCostUsd: normalized.maxCostUsd });
    }
    const repo = await this.repos.findById(normalized.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    // Today's two-pass flow: the repo's own default branch replaces the placeholder of the first pass.
    const resolved = validateCreateThread({ ...input, kind: 'REPO' }, repo.defaultBranch);
    const skills = await this.skills.snapshotForProject(projectId);
    try {
      return await this.threads.create({ kind: 'REPO', projectId, repoId: repo.id, baseRef: resolved.baseRef, feature: resolved.feature, title: resolved.title, createdById: userId, backend: resolved.backend, skills, maxCostUsd: resolved.maxCostUsd });
    } catch (error) {
      if (isUniqueViolation(error, 'repo_feature')) throw new ConflictAppException({ feature: resolved.feature }, 'threads.featureTaken');
      throw error;
    }
  }

  async list(projectId: string, status: string | undefined, skip: number, take: number): Promise<{ items: ChatThreadRecord[]; threadsEnabled: boolean }> {
    return { items: await this.threads.list(projectId, status, skip, take), threadsEnabled: this.config.threadsEnabled };
  }
  async get(projectId: string, id: string): Promise<ChatThreadDetail> {
    const result = await this.threads.get(projectId, id);
    if (!result) throw new NotFoundAppException({}, 'threads.notFound');
    const [sendRefusal, handoff] = await Promise.all([this.threads.sendRefusalOf(projectId, result), this.threads.handoff(result.id)]);
    return { ...result, sendRefusal, handoff };
  }
  async messages(projectId: string, id: string, afterSeq: number, limit: number): Promise<{ items: ChatMessageRecord[] }> {
    const thread = await this.threads.get(projectId, id);
    if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
    return { items: await this.threads.messages(thread.id, afterSeq, limit) };
  }

  async updateCap(projectId: string, threadId: string, userId: string, value: unknown): Promise<ChatThreadRecord> {
    if (!isMaxCostUsd(value)) throw new ValidationAppException({ reason: 'maxCostUsd' }, 'threads.input');
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

  async plan(projectId: string, threadId: string, userId: string, input: PlanThreadDto): Promise<import('../jobs/dto/fleet-job.dto').DispatchResultDto> {
    const thread = await this.threads.get(projectId, threadId);
    if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
    // 1a-R3: Plan is REPO-only, and the guard runs before the creator check so a PROJECT thread answers 409.
    const { repoId, feature, specPath } = repoThreadFields(thread);
    if (thread.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    if (thread.status === 'ARCHIVED') throw new ConflictAppException({}, 'threads.archived');
    if (!thread.specPublished) throw new ConflictAppException({}, 'threads.notPublished');
    if (!thread.runnerId) throw new ConflictAppException({}, 'threads.runnerMissing');
    return this.fleetJobs.dispatch(userId, projectId, {
      repoId, command: 'PLAN', ref: `feat/${feature}`, feature,
      planFrom: specPath, profiles: input.profiles, maxCostUsd: input.maxCostUsd ?? THREAD_HANDOFF_DEFAULT_MAX_COST_USD,
      pinnedRunnerId: thread.runnerId ?? undefined,
    }, { threadId });
  }

  /** US-007: dispatches the thread's RUN after its latest PLAN completed. Same gates and cap default as Plan. */
  async run(projectId: string, threadId: string, userId: string, input: RunThreadDto): Promise<import('../jobs/dto/fleet-job.dto').DispatchResultDto> {
    const thread = await this.threads.get(projectId, threadId);
    if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
    // 1a-R3: Run is REPO-only, and the guard runs before the creator check so a PROJECT thread answers 409.
    const { repoId, feature } = repoThreadFields(thread);
    if (thread.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    if (thread.status === 'ARCHIVED') throw new ConflictAppException({}, 'threads.archived');
    const { plan } = await this.threads.handoff(thread.id);
    if (plan?.state !== 'COMPLETED') throw new ConflictAppException({}, 'threads.notPlanned');
    if (!thread.runnerId) throw new ConflictAppException({}, 'threads.runnerMissing');
    return this.fleetJobs.dispatch(userId, projectId, {
      repoId, command: 'RUN', ref: `feat/${feature}`, feature,
      profiles: input.profiles, maxCostUsd: input.maxCostUsd ?? THREAD_HANDOFF_DEFAULT_MAX_COST_USD,
      bashMode: input.bashMode, pinnedRunnerId: thread.runnerId ?? undefined,
    }, { threadId });
  }

  publish(projectId: string, threadId: string, userId: string): Promise<{ jobId: string | null }> {
    return this.threads.publish(projectId, threadId, userId);
  }

  discard(projectId: string, threadId: string, userId: string): Promise<{ jobId: string }> {
    return this.threads.discard(projectId, threadId, userId);
  }

  async sendMessage(projectId: string, threadId: string, userId: string, input: SendMessageDto): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }> {
    if (typeof input.text !== 'string' || input.text.length === 0 || Buffer.byteLength(input.text, 'utf8') > 32768 ||
        typeof input.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.clientMessageId)) {
      throw new ValidationAppException({ reason: 'message' }, 'threads.input');
    }
    // 1c-D1: the repository context is resolved here, before the send transaction, because the GitHub read must not
    // run inside it. A missing thread skips the resolution entirely: the repository answers its own not-found.
    const thread = await this.threads.get(projectId, threadId);
    const repoContext = thread ? await this.projectBrief.resolveRepoContext(await this.repoIdForThread(projectId, thread)) : undefined;
    return this.threads.sendMessage({ projectId, threadId, userId, text: input.text, clientMessageId: input.clientMessageId, repoContext });
  }

  /**
   * The repository whose context file a turn's brief block reads (1c-D2): the REPO thread's own repository, or the
   * project's anchor repository for a PROJECT thread — the same repo its job lands on — and null when the project has
   * no fleet repo. Both are read at their own default branch (inside `ProjectBriefService`), never the thread's baseRef.
   */
  private async repoIdForThread(projectId: string, thread: ChatThreadRecord): Promise<string | null> {
    if (thread.kind !== 'PROJECT') return thread.repoId;
    return (await this.repos.findAnchor(projectId))?.id ?? null;
  }
}
