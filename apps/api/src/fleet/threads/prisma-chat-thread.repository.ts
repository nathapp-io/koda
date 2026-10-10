import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';
import { DEFAULT_APPROVAL_TIMEOUT_SEC } from '../common/protocol';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, type IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { PlacementService } from '../jobs/placement.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { buildThreadInstructions } from './thread-instructions';
import type { ChatMessageRecord, ChatThreadRecord, ChatThreadRepository } from './domain/chat-thread.domain';
import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';
import type { ThreadBackend } from '../common/thread-jobs';

@Injectable()
export class PrismaChatThreadRepository implements ChatThreadRepository {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: IFleetJobRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly activity: FleetActivityService,
    private readonly placement: PlacementService,
    private readonly notifier: RunnerNotifier,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
  ) {}

  async create(input: { projectId: string; repoId: string; baseRef: string; feature: string; title: string; createdById: string; backend: ThreadBackend; skills: ThreadSkillSource[]; maxCostUsd: string }): Promise<ChatThreadRecord> {
    const row = await this.prisma.client.chatThread.create({ data: {
      ...input,
      backend: input.backend as Prisma.InputJsonValue,
      skills: input.skills as unknown as Prisma.InputJsonValue,
      specPath: `.nax/features/${input.feature}/spec.md`,
    } });
    return this.mapThread(row, null);
  }

  async list(projectId: string, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]> {
    const rows = await this.prisma.client.chatThread.findMany({ where: { projectId, ...(status ? { status } : {}) }, skip, take, orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }] });
    const jobs = rows.length ? await this.prisma.client.fleetJob.findMany({ where: { threadId: { in: rows.map((row) => row.id) }, command: 'THREAD', state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true, threadId: true } }) : [];
    const active = new Map<string, { id: string; state: string }>();
    for (const job of jobs) if (job.threadId && !active.has(job.threadId)) active.set(job.threadId, { id: job.id, state: job.state });
    return rows.map((row) => this.mapThread(row, active.get(row.id) ?? null));
  }

  async get(projectId: string, id: string): Promise<ChatThreadRecord | null> {
    const row = await this.prisma.client.chatThread.findFirst({ where: { id, projectId } });
    if (!row) return null;
    const job = await this.prisma.client.fleetJob.findFirst({ where: { threadId: id, command: 'THREAD', state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true } });
    return this.mapThread(row, job);
  }

  async messages(threadId: string, afterSeq: number, limit: number): Promise<ChatMessageRecord[]> {
    const rows = await this.prisma.client.chatMessage.findMany({ where: { threadId, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: limit });
    return rows.map(({ threadId: _threadId, ...row }) => ({ ...row, costUsd: row.costUsd?.toString() ?? null }));
  }

  async sendMessage(input: { projectId: string; threadId: string; userId: string; text: string; clientMessageId: string }): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.txManager.run(async () => {
        const threadBefore = await this.prisma.client.chatThread.findFirst({ where: { id: input.threadId, projectId: input.projectId } });
        if (!threadBefore) throw new NotFoundAppException({}, 'threads.notFound');
        if (threadBefore.createdById !== input.userId) throw new ForbiddenAppException({}, 'threads.notCreator');
        const duplicate = await this.prisma.client.chatMessage.findUnique({ where: { threadId_clientMessageId: { threadId: input.threadId, clientMessageId: input.clientMessageId } } });
        if (duplicate) return { kind: 'done' as const, result: { message: this.mapMessage(duplicate), jobId: null, deduplicated: true } };

        const currentJob = await this.currentThreadJob(input.threadId);
        if (currentJob) await this.jobs.lockById(currentJob.id);
        await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${input.threadId} FOR UPDATE`;
        const thread = await this.prisma.client.chatThread.findFirst({ where: { id: input.threadId, projectId: input.projectId } });
        if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
        const currentAfterLock = await this.currentThreadJob(input.threadId);
        if ((currentJob?.id ?? null) !== (currentAfterLock?.id ?? null)) return { kind: 'retry' as const };
        if (thread.createdById !== input.userId) throw new ForbiddenAppException({}, 'threads.notCreator');
        const duplicateAfterLock = await this.prisma.client.chatMessage.findUnique({ where: { threadId_clientMessageId: { threadId: input.threadId, clientMessageId: input.clientMessageId } } });
        if (duplicateAfterLock) return { kind: 'done' as const, result: { message: this.mapMessage(duplicateAfterLock), jobId: null, deduplicated: true } };

        const seqResult = await this.prisma.client.$queryRaw<Array<{ nextSeq: number }>>`UPDATE "ChatThread" SET "nextSeq" = "nextSeq" + 1 WHERE "id" = ${thread.id} RETURNING "nextSeq" - 1 AS "nextSeq"`;
        const seq = seqResult[0]?.nextSeq;
        if (seq === undefined) throw new Error(`failed to allocate message sequence for thread ${thread.id}`);
        const messageRow = await this.prisma.client.chatMessage.create({ data: {
          threadId: thread.id, seq, role: 'user', status: 'pending', authorUserId: input.userId,
          clientMessageId: input.clientMessageId, content: input.text,
        } });
        await this.prisma.client.chatThread.update({ where: { id: thread.id }, data: { lastActivityAt: new Date() } });
        const message = this.mapMessage(messageRow);
        const repo = await this.prisma.client.fleetRepo.findUnique({ where: { id: thread.repoId }, select: { owner: true, name: true } });
        if (!repo) throw new NotFoundAppException({}, 'fleet.repos');

        const runnerRow = thread.runnerId ? await this.prisma.client.runner.findUnique({ where: { id: thread.runnerId }, select: { id: true, enabled: true, lastSeenAt: true, protocolVersion: true } }) : null;
        const hasPendingMessage = await this.prisma.client.chatMessage.findFirst({ where: { threadId: thread.id, status: 'pending', id: { not: message.id } }, select: { id: true } });
        const closeCommand = currentAfterLock ? await this.prisma.client.fleetCommand.findFirst({ where: { jobId: currentAfterLock.id, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: currentAfterLock.leaseEpoch }, select: { id: true } }) : null;
        const runnerOnline = runnerRow?.enabled === true && runnerRow.lastSeenAt.getTime() >= Date.now() - this.config.runnerOfflineSec * 1000;
        const liveSession = currentAfterLock?.state === 'RUNNING' && runnerOnline && runnerRow.protocolVersion >= 4 && !hasPendingMessage && !closeCommand;
        if (liveSession && currentAfterLock?.runnerId) {
          await this.jobs.createCommand({ runnerId: currentAfterLock.runnerId, jobId: currentAfterLock.id, type: FleetCommandType.THREAD_INPUT, leaseEpoch: currentAfterLock.leaseEpoch, payload: { messageId: message.id, text: input.text } });
          return { kind: 'done' as const, result: { message, jobId: null, deduplicated: false }, notifyRunnerId: currentAfterLock.runnerId };
        }

        const previousJob = await this.prisma.client.fleetJob.findFirst({ where: { threadId: thread.id, command: 'THREAD' }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true } });
        const remaining = new Prisma.Decimal(thread.maxCostUsd).minus(thread.costUsd);
        const feature = `thread-${thread.id}`;
        let job;
        try {
          job = await this.jobs.createJob({
            projectId: thread.projectId, repoId: thread.repoId, ref: thread.baseRef, command: 'THREAD', threadId: thread.id,
            feature, planFrom: null, profiles: [], maxCostUsd: remaining.toString(), bashMode: 'raw',
            approvalTimeoutSec: DEFAULT_APPROVAL_TIMEOUT_SEC, selectorLabels: [], pinnedRunnerId: thread.runnerId,
            requestedById: thread.createdById,
          });
        } catch (error) {
          if (error instanceof DuplicateActiveJobError) throw new ConflictAppException({}, 'threads.turnRunning');
          throw error;
        }
        const skills = thread.skills as unknown as ThreadSkillSource[];
        const backend = thread.backend as unknown as ThreadBackend;
        const instructions = buildThreadInstructions({ repo: `${repo.owner}/${repo.name}`, baseRef: thread.baseRef, feature: thread.feature, specPath: thread.specPath, skills });
        const turn = await this.prisma.client.fleetThreadTurn.create({ data: {
          jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: message.id, instructions,
          backend: backend as Prisma.InputJsonValue, skills: skills as unknown as Prisma.InputJsonValue, resume: previousJob !== null,
        } });
        await this.prisma.client.chatMessage.update({ where: { id: message.id }, data: { jobId: job.id, turnId: turn.jobId } });
        const linkedMessage = { ...message, jobId: job.id, turnId: turn.jobId };
        await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({ actorType: 'USER', actorId: input.userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id,
          projectId: thread.projectId, responsibleUserId: input.userId, payload: { repoId: thread.repoId, feature, command: 'THREAD', ref: thread.baseRef } });
        return { kind: 'done' as const, result: { message: linkedMessage, jobId: job.id, deduplicated: false }, placeJobId: job.id };
      });
      if (outcome.kind === 'retry') continue;
      if (outcome.notifyRunnerId) this.notifier.notify(outcome.notifyRunnerId);
      if (outcome.placeJobId) await this.placement.placeJob(outcome.placeJobId);
      return outcome.result;
    }
    throw new ConflictAppException({}, 'threads.turnRunning');
  }

  private async currentThreadJob(threadId: string) {
    return this.prisma.client.fleetJob.findFirst({
      where: { threadId, command: 'THREAD', state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, runnerId: true, leaseEpoch: true },
    });
  }

  private mapMessage(row: Prisma.ChatMessageGetPayload<object>): ChatMessageRecord {
    const { threadId: _threadId, ...message } = row;
    return { ...message, costUsd: row.costUsd?.toString() ?? null };
  }

  private mapThread(row: Prisma.ChatThreadGetPayload<object>, activeJob: { id: string; state: string } | null): ChatThreadRecord {
    return {
      id: row.id, repoId: row.repoId, baseRef: row.baseRef, feature: row.feature,
      title: row.title, createdById: row.createdById, runnerId: row.runnerId,
      backend: row.backend as unknown as ThreadBackend, status: row.status, archivedAt: row.archivedAt,
      skills: row.skills as unknown as ThreadSkillSource[], maxCostUsd: row.maxCostUsd.toString(),
      costUsd: row.costUsd.toString(), tokens: row.tokens, specPath: row.specPath,
      pendingQuestion: row.pendingQuestion, lastActivityAt: row.lastActivityAt, createdAt: row.createdAt, activeJob,
    };
  }
}
