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
import { isRunnerOnline } from '../common/runner-online';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, type IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ACTIVE_STATES } from '../jobs/job-state';
import { THREAD_MIN_PROTOCOL_VERSION } from './thread-send-rules';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { PlacementService } from '../jobs/placement.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { BudgetGate } from '../budgets/budget-gate';
import { jobGateKeys } from '../budgets/budget-rules';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { buildThreadInstructions } from './thread-instructions';
import { sendRefusal, type ThreadSendRefusal } from './thread-send-rules';
import { allocateThreadSeq, repoThreadFields, type ChatMessageRecord, type ChatThreadRecord, type ChatThreadRepository, type ThreadSession, type ThreadWriteResult } from './domain/chat-thread.domain';
import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';
import type { ChatThreadKind, ThreadAction, ThreadBackend } from '../common/thread-jobs';
import { THREAD_LIMITS } from '../common/thread-jobs';

/** The states a thread's current job is no longer live in (job-state.ts owns these). Prisma's `notIn` wants a mutable list. */
const TERMINAL_JOB_STATES: string[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'];

/** Only a stored `PROJECT` reads as one; anything else (missing on old rows, or unknown) is a REPO thread (US-002). */
const mapThreadKind = (kind: string | null | undefined): ChatThreadKind => (kind === 'PROJECT' ? 'PROJECT' : 'REPO');

/** A budget refusal carries the paused policy so the 409 names its scope. */
type SendRefusalResult = { refusal: 'budgetPaused'; pausedPolicy: BudgetPolicyRecord } | { refusal: Exclude<ThreadSendRefusal, 'budgetPaused'> | null; pausedPolicy: null };

@Injectable()
export class PrismaChatThreadRepository implements ChatThreadRepository {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: IFleetJobRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly activity: FleetActivityService,
    private readonly placement: PlacementService,
    private readonly notifier: RunnerNotifier,
    private readonly budgets: BudgetGate,
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
    const jobs = rows.length ? await this.prisma.client.fleetJob.findMany({ where: { threadId: { in: rows.map((row) => row.id) }, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true, threadId: true } }) : [];
    const active = new Map<string, { id: string; state: string }>();
    for (const job of jobs) if (job.threadId && !active.has(job.threadId)) active.set(job.threadId, { id: job.id, state: job.state });
    return rows.map((row) => this.mapThread(row, active.get(row.id) ?? null));
  }

  async get(projectId: string, id: string): Promise<ChatThreadRecord | null> {
    const row = await this.prisma.client.chatThread.findFirst({ where: { id, projectId } });
    if (!row) return null;
    const job = await this.prisma.client.fleetJob.findFirst({ where: { threadId: id, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true } });
    return this.mapThread(row, job);
  }

  async handoff(threadId: string) {
    const [plan, run] = await Promise.all([
      this.prisma.client.fleetJob.findFirst({ where: { threadId, command: 'PLAN' }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true, stateReason: true } }),
      this.prisma.client.fleetJob.findFirst({ where: { threadId, command: 'RUN' }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true, stateReason: true } }),
    ]);
    return {
      plan: plan ? { jobId: plan.id, state: plan.state, stateReason: plan.stateReason } : null,
      run: run ? { jobId: run.id, state: run.state, stateReason: run.stateReason } : null,
    };
  }

  async sendRefusalOf(projectId: string, thread: ChatThreadRecord): Promise<ThreadSendRefusal | null> {
    const job = await this.prisma.client.fleetJob.findFirst({
      where: { threadId: thread.id, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, leaseEpoch: true },
    });
    const result = await this.sendRefusalFor({
      id: thread.id, status: thread.status, runnerId: thread.runnerId, repoId: thread.repoId, projectId,
      costUsd: new Prisma.Decimal(thread.costUsd), maxCostUsd: new Prisma.Decimal(thread.maxCostUsd),
    }, job);
    return result.refusal;
  }

  async messages(threadId: string, afterSeq: number, limit: number): Promise<ChatMessageRecord[]> {
    const rows = await this.prisma.client.chatMessage.findMany({ where: { threadId, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: limit });
    return rows.map((row) => this.mapMessage(row));
  }

  async archivedThreadIds(runnerId: string): Promise<string[]> {
    const rows = await this.prisma.client.chatThread.findMany({ where: { runnerId, status: 'ARCHIVED' }, orderBy: [{ archivedAt: 'desc' }, { id: 'desc' }], take: THREAD_LIMITS.maxArchivedThreadIds, select: { id: true } });
    return rows.map((row) => row.id);
  }

  async updateCap(projectId: string, threadId: string, userId: string, maxCostUsd: string): Promise<ChatThreadRecord> {
    const updated = await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (before.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      const job = await this.currentThreadJob(threadId);
      if (job) await this.jobs.lockById(job.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const row = await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { maxCostUsd } });
      return this.mapThread(row, job);
    });
    return updated;
  }

  async command(projectId: string, threadId: string, userId: string, type: string, payload: object): Promise<void> {
    let runnerId: string | null = null;
    await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (before.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      const current = await this.currentThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      if (thread.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      if (type === FleetCommandType.THREAD_ANSWER) {
        const question = thread.pendingQuestion as { requestId?: unknown } | null;
        const requestId = (payload as { requestId?: unknown }).requestId;
        if (!question || question.requestId !== requestId) throw new ConflictAppException({}, 'threads.noQuestion');
      }
      const job = await this.currentThreadJob(threadId);
      if (!current || current.id !== job?.id || job.state !== 'RUNNING' || !job.runnerId) throw new ConflictAppException({}, 'threads.noSession');
      // C2-D7: a PUBLISH or DISCARD job has no session to stop or end (the question check above already ran).
      if (type === FleetCommandType.THREAD_STOP_TURN || type === FleetCommandType.THREAD_CLOSE) {
        const turn = await this.prisma.client.fleetThreadTurn.findUnique({ where: { jobId: job.id }, select: { action: true } });
        if (turn?.action === 'PUBLISH' || turn?.action === 'DISCARD') throw new ConflictAppException({}, 'threads.noSession');
      }
      const closed = await this.prisma.client.fleetCommand.findFirst({ where: { jobId: job.id, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: job.leaseEpoch }, select: { id: true } });
      if (closed) throw new ConflictAppException({}, 'threads.noSession');
      await this.jobs.createCommand({ runnerId: job.runnerId, jobId: job.id, type: type as FleetCommandType, leaseEpoch: job.leaseEpoch, payload });
      runnerId = job.runnerId;
    });
    if (runnerId) this.notifier.notify(runnerId);
  }

  async archive(projectId: string, threadId: string, userId: string, canArchive: boolean): Promise<string | null> {
    return this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (before.createdById !== userId && !canArchive) throw new ForbiddenAppException({}, 'threads.notCreator');
      const current = await this.currentThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      if (thread.status === 'ARCHIVED') return null;
      await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      // A send that took the locks first may have created a job the pre-lock read never saw, so
      // the cancel target is read again under the thread row lock.
      return (await this.currentThreadJob(threadId))?.id ?? null;
    });
  }

  async publish(projectId: string, threadId: string, userId: string): Promise<{ jobId: string | null }> {
    let notifyRunnerId: string | null = null;
    let placeJobId: string | null = null;
    const result = await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      // 1a-R3: Publish is REPO-only, and the guard runs before the creator check so a PROJECT thread answers 409.
      const repoFields = repoThreadFields(before);
      if (before.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      const current = await this.activeThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      const active = await this.activeThreadJob(threadId);
      if ((current?.id ?? null) !== (active?.id ?? null)) throw new ConflictAppException({}, 'threads.busy');
      if (thread.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
      if (thread.status === 'ARCHIVED') throw new ConflictAppException({}, 'threads.archived');
      if (!thread.runnerId) throw new ConflictAppException({}, 'threads.nothingToPublish');
      const runner = await this.prisma.client.runner.findUnique({ where: { id: thread.runnerId }, select: { lastSeenAt: true, protocolVersion: true, capabilities: true } });
      if (!runner || !isRunnerOnline(runner.lastSeenAt, new Date(), this.config.runnerOfflineSec)) throw new ConflictAppException({}, 'threads.runnerOffline');
      const capabilities = runner.capabilities as { threadWrite?: unknown };
      if (runner.protocolVersion < THREAD_MIN_PROTOCOL_VERSION || capabilities.threadWrite !== true) throw new ConflictAppException({}, 'threads.runnerOutdated');
      const pausedPolicy = this.budgets.snapshot(new Date()).then((snapshot) => snapshot.match(jobGateKeys({ projectId: thread.projectId, repoId: repoFields.repoId, pinnedRunnerId: thread.runnerId })));
      const paused = await pausedPolicy;
      if (paused) throw new BudgetPausedException(paused);
      if (active?.command === 'THREAD' && active.action === 'SESSION') {
        const close = await this.prisma.client.fleetCommand.findFirst({ where: { jobId: active.id, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: active.leaseEpoch }, select: { id: true } });
        if (active.state === 'UPLOADING' || (active.state === 'RUNNING' && close)) throw new ConflictAppException({}, 'threads.closing');
        const inFlight = await this.prisma.client.chatMessage.findFirst({ where: { threadId, status: { in: ['pending', 'streaming'] } }, select: { id: true } });
        if (active.state === 'QUEUED' || active.state === 'ASSIGNED' || inFlight) throw new ConflictAppException({}, 'threads.turnRunning');
        if (active.state !== 'RUNNING' || !active.runnerId) throw new ConflictAppException({}, 'threads.busy');
        await this.jobs.createCommand({ runnerId: active.runnerId, jobId: active.id, type: FleetCommandType.THREAD_PUBLISH, leaseEpoch: active.leaseEpoch, payload: {} });
        notifyRunnerId = active.runnerId;
        return { jobId: null };
      }
      if (active) throw new ConflictAppException({}, 'threads.busy');
      if (thread.writtenPaths.length === 0) throw new ConflictAppException({}, 'threads.nothingToPublish');
      const job = await this.createThreadJob(thread, 'PUBLISH');
      await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
      await this.activity.record({ actorType: 'USER', actorId: userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id, projectId: thread.projectId, responsibleUserId: userId, payload: { repoId: repoFields.repoId, feature: `thread-${thread.id}`, command: 'THREAD', ref: repoFields.baseRef } });
      placeJobId = job.id;
      return { jobId: job.id };
    });
    if (notifyRunnerId) this.notifier.notify(notifyRunnerId);
    if (placeJobId) await this.placement.placeJob(placeJobId);
    return result;
  }

  /**
   * Discard clears a stale session's unpublished changes (fleet S5a §4). Same locks and creator gate as Publish; it
   * refuses any active job of the thread, a live session included, so the DISCARD job runs alone in the worktree.
   */
  async discard(projectId: string, threadId: string, userId: string): Promise<{ jobId: string }> {
    let placeJobId: string | null = null;
    const result = await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      // 1a-R3: Discard is REPO-only, and the guard runs before the creator check so a PROJECT thread answers 409.
      const repoFields = repoThreadFields(before);
      if (before.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      const current = await this.activeThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      const active = await this.activeThreadJob(threadId);
      if ((current?.id ?? null) !== (active?.id ?? null)) throw new ConflictAppException({}, 'threads.busy');
      if (thread.createdById !== userId) throw new ForbiddenAppException({}, 'threads.notCreator');
      if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
      if (thread.status === 'ARCHIVED') throw new ConflictAppException({}, 'threads.archived');
      if (!thread.runnerId) throw new ConflictAppException({}, 'threads.nothingToDiscard');
      const runner = await this.prisma.client.runner.findUnique({ where: { id: thread.runnerId }, select: { lastSeenAt: true, protocolVersion: true, capabilities: true } });
      if (!runner || !isRunnerOnline(runner.lastSeenAt, new Date(), this.config.runnerOfflineSec)) throw new ConflictAppException({}, 'threads.runnerOffline');
      const capabilities = runner.capabilities as { threadWrite?: unknown };
      if (runner.protocolVersion < THREAD_MIN_PROTOCOL_VERSION || capabilities.threadWrite !== true) throw new ConflictAppException({}, 'threads.runnerOutdated');
      const paused = (await this.budgets.snapshot(new Date())).match(jobGateKeys({ projectId: thread.projectId, repoId: repoFields.repoId, pinnedRunnerId: thread.runnerId }));
      if (paused) throw new BudgetPausedException(paused);
      if (active) throw new ConflictAppException({}, 'threads.busy');
      const job = await this.createThreadJob(thread, 'DISCARD');
      await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
      await this.activity.record({ actorType: 'USER', actorId: userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id, projectId: thread.projectId, responsibleUserId: userId, payload: { repoId: repoFields.repoId, feature: `thread-${thread.id}`, command: 'THREAD', ref: repoFields.baseRef } });
      placeJobId = job.id;
      return { jobId: job.id };
    });
    if (placeJobId) await this.placement.placeJob(placeJobId);
    return result;
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

        const refused = await this.sendRefusalFor(thread, currentAfterLock);
        if (refused.refusal === 'budgetPaused') throw new BudgetPausedException(refused.pausedPolicy);
        if (refused.refusal) throw this.refusalException(refused.refusal);
        const active = await this.activeThreadJob(thread.id);
        if (active && (active.command !== 'THREAD' || active.action === 'PUBLISH' || active.action === 'DISCARD')) {
          throw new ConflictAppException({}, 'threads.busy');
        }

        // A completed out-of-band message can sit at or above the counter, so the shared allocator takes the higher.
        const seq = await allocateThreadSeq(this.prisma.client, thread.id);
        const messageRow = await this.prisma.client.chatMessage.create({ data: {
          threadId: thread.id, seq, role: 'user', status: 'pending', authorUserId: input.userId,
          clientMessageId: input.clientMessageId, content: input.text,
        } });
        await this.prisma.client.chatThread.update({ where: { id: thread.id }, data: { lastActivityAt: new Date() } });
        const message = this.mapMessage(messageRow);
        // The refusal gate passed, so a RUNNING job here is a live session with no turn in flight.
        if (currentAfterLock?.state === 'RUNNING' && currentAfterLock.runnerId) {
          await this.jobs.createCommand({ runnerId: currentAfterLock.runnerId, jobId: currentAfterLock.id, type: FleetCommandType.THREAD_INPUT, leaseEpoch: currentAfterLock.leaseEpoch, payload: { messageId: message.id, text: input.text } });
          return { kind: 'done' as const, result: { message, jobId: null, deduplicated: false }, notifyRunnerId: currentAfterLock.runnerId };
        }

        const job = await this.createThreadJob(thread, 'SESSION', message);
        await this.prisma.client.chatMessage.update({ where: { id: message.id }, data: { jobId: job.id, turnId: job.id } });
        const linkedMessage = { ...message, jobId: job.id, turnId: job.id };
        await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({ actorType: 'USER', actorId: input.userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id,
          projectId: thread.projectId, responsibleUserId: input.userId, payload: { repoId: thread.repoId, feature: `thread-${thread.id}`, command: 'THREAD', ref: thread.baseRef } });
        return { kind: 'done' as const, result: { message: linkedMessage, jobId: job.id, deduplicated: false }, placeJobId: job.id };
      });
      if (outcome.kind === 'retry') continue;
      if (outcome.notifyRunnerId) this.notifier.notify(outcome.notifyRunnerId);
      if (outcome.placeJobId) await this.placement.placeJob(outcome.placeJobId);
      return outcome.result;
    }
    throw new ConflictAppException({}, 'threads.turnRunning');
  }

  /** The facts `sendRefusal` judges, read under the thread and job locks. Writes nothing. */
  private async sendRefusalFor(thread: { id: string; status: string; costUsd: Prisma.Decimal; maxCostUsd: Prisma.Decimal; runnerId: string | null; projectId: string; repoId: string | null }, job: { id: string; state: string; leaseEpoch: number } | null): Promise<SendRefusalResult> {
    const pauses = await this.budgets.snapshot(new Date());
    const pausedPolicy = pauses.match(jobGateKeys({ projectId: thread.projectId, repoId: thread.repoId, pinnedRunnerId: thread.runnerId }));
    const runnerRow = thread.runnerId ? await this.prisma.client.runner.findUnique({ where: { id: thread.runnerId }, select: { lastSeenAt: true, protocolVersion: true } }) : null;
    const closeCommand = job ? await this.prisma.client.fleetCommand.findFirst({ where: { jobId: job.id, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: job.leaseEpoch }, select: { id: true } }) : null;
    const turnInFlight = await this.prisma.client.chatMessage.findFirst({ where: { threadId: thread.id, status: { in: ['pending', 'streaming'] } }, select: { id: true } });
    const refusal = sendRefusal({
      threadsEnabled: this.config.threadsEnabled,
      status: thread.status, costUsd: thread.costUsd, maxCostUsd: thread.maxCostUsd,
      pausedPolicy,
      runner: runnerRow ? { online: isRunnerOnline(runnerRow.lastSeenAt, new Date(), this.config.runnerOfflineSec), protocolVersion: runnerRow.protocolVersion } : null,
      job: job ? { state: job.state, closeRequested: closeCommand !== null } : null,
      turnInFlight: turnInFlight !== null,
    });
    if (refusal === 'budgetPaused' && pausedPolicy) return { refusal: 'budgetPaused', pausedPolicy };
    return { refusal, pausedPolicy: null };
  }

  private refusalException(refusal: Exclude<ThreadSendRefusal, 'budgetPaused'>): Error {
    switch (refusal) {
      case 'disabled': return new ConflictAppException({}, 'threads.disabled');
      case 'archived': return new ConflictAppException({}, 'threads.archived');
      case 'costCap': return new ConflictAppException({}, 'threads.costCap');
      case 'runnerOffline': return new ConflictAppException({}, 'threads.runnerOffline');
      case 'runnerOutdated': return new ConflictAppException({}, 'threads.runnerOutdated');
      case 'closing': return new ConflictAppException({}, 'threads.closing');
      case 'turnRunning': return new ConflictAppException({}, 'threads.turnRunning');
    }
  }

  private async activeThreadJob(threadId: string) {
    const job = await this.prisma.client.fleetJob.findFirst({
      where: { threadId, state: { in: [...ACTIVE_STATES] } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      include: { threadTurn: { select: { action: true } } },
    });
    return job ? { ...job, action: job.threadTurn?.action ?? null } : null;
  }

  /**
   * Creates the THREAD job of a REPO thread and its turn. The guard is the last line before the write: a PROJECT
   * thread has no repo to check out, so it answers 409 `threads.notRepoThread` (the PROJECT branch is US-004).
   */
  private async createThreadJob(thread: Prisma.ChatThreadGetPayload<object>, action: ThreadAction, message?: ChatMessageRecord) {
    const { repoId, baseRef, feature, specPath } = repoThreadFields(thread);
    const repo = await this.prisma.client.fleetRepo.findUnique({ where: { id: repoId }, select: { owner: true, name: true } });
    if (!repo) throw new NotFoundAppException({}, 'fleet.repos');
    const previousSession = action === 'SESSION' ? await this.prisma.client.fleetThreadTurn.findFirst({ where: { threadId: thread.id, action: 'SESSION' }, select: { jobId: true } }) : null;
    const skills = thread.skills as unknown as ThreadSkillSource[];
    const backend = thread.backend as unknown as ThreadBackend;
    const instructions = buildThreadInstructions({ repo: `${repo.owner}/${repo.name}`, baseRef, feature, specPath, skills });
    const remaining = new Prisma.Decimal(thread.maxCostUsd).minus(thread.costUsd);
    let job;
    try {
      job = await this.jobs.createJob({
        projectId: thread.projectId, repoId, ref: baseRef, command: 'THREAD', threadId: thread.id,
        feature: `thread-${thread.id}`, planFrom: null, profiles: [], maxCostUsd: action === 'SESSION' ? remaining.toString() : '0', bashMode: 'raw',
        approvalTimeoutSec: DEFAULT_APPROVAL_TIMEOUT_SEC, selectorLabels: [], pinnedRunnerId: thread.runnerId,
        requestedById: thread.createdById,
      });
    } catch (error) {
      if (error instanceof DuplicateActiveJobError) throw new ConflictAppException({}, action === 'SESSION' ? 'threads.turnRunning' : 'threads.busy');
      throw error;
    }
    await this.prisma.client.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action, initialMessageId: message?.id ?? null, instructions,
      backend: backend as Prisma.InputJsonValue, skills: skills as unknown as Prisma.InputJsonValue,
      resume: action === 'SESSION' && previousSession !== null,
    } });
    return job;
  }

  private async currentThreadJob(threadId: string) {
    return this.prisma.client.fleetJob.findFirst({
      where: { threadId, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, runnerId: true, leaseEpoch: true },
    });
  }

  /** Strips the fold-internal columns (`threadId`, `streamRound`, `streamRoundStart`) that never leave the API. */
  private mapMessage(row: Prisma.ChatMessageGetPayload<object>): ChatMessageRecord {
    const { threadId: _threadId, streamRound: _streamRound, streamRoundStart: _streamRoundStart, ...message } = row;
    return { ...message, costUsd: row.costUsd?.toString() ?? null };
  }

  private mapThread(row: Prisma.ChatThreadGetPayload<object>, activeJob: { id: string; state: string } | null): ChatThreadRecord {
    return {
      id: row.id, kind: mapThreadKind(row.kind), repoId: row.repoId, baseRef: row.baseRef, feature: row.feature,
      title: row.title, createdById: row.createdById, runnerId: row.runnerId,
      backend: row.backend as unknown as ThreadBackend, status: row.status, archivedAt: row.archivedAt,
      skills: row.skills as unknown as ThreadSkillSource[], maxCostUsd: row.maxCostUsd.toString(),
      costUsd: row.costUsd.toString(), tokens: row.tokens, specPath: row.specPath,
      pendingQuestion: row.pendingQuestion, session: (row.session as unknown as ThreadSession | null) ?? null,
      lastActivityAt: row.lastActivityAt, createdAt: row.createdAt, activeJob,
      writtenPaths: row.writtenPaths, publishedSha: row.publishedSha, specPublished: row.specPublished,
      lastWrite: (row.lastWrite as unknown as ThreadWriteResult | null) ?? null,
    };
  }
}
