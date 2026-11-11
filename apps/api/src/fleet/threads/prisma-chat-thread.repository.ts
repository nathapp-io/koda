import { randomUUID } from 'node:crypto';
import { committedEffect } from '../../common/committed-effects';
import { ThreadEventBus } from '../../live/thread-event-bus';
import { threadModeKey } from './thread-mode';
import threadMessages from '../../i18n/en/threads.json';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';
import { actorTypeFor, type ActorType } from '../../action-context/action-context';
import { DEFAULT_APPROVAL_TIMEOUT_SEC, type RunnerCapabilities } from '../common/protocol';
import { threadCapabilityMisfit, threadModeMisfit, THREAD_MISFIT_ORDER, type ThreadCapabilityMisfit } from '../jobs/placement-rules';
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
import { buildWorkspaceThreadInstructions, buildProjectThreadInstructions, buildThreadInstructions, renderBriefBlock } from './thread-instructions';
import { sendRefusal, type ThreadSendRefusal } from './thread-send-rules';
import { allocateThreadSeq, repoThreadFields, type ChatMessageRecord, type ChatThreadPendingAction, type ChatThreadRecord, type ChatThreadRepository, type ThreadPreApproval, type UnstartedTurn, type ThreadScope, type ThreadServeNeed, type ThreadSession, type ThreadWriteResult } from './domain/chat-thread.domain';
import { readPendingApprovals } from './domain/pending-approvals';
import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';
import { MAX_PENDING_ACTIONS } from '../assistant/requests/assistant-action-request.domain';
import { DELIVERABLE_STATUSES, MAX_DELIVERED_NOTES, deliveryText } from '../assistant/actions/outcome-delivery';
import { requestOutcomeNote } from '../assistant/requests/request-outcome-note';
import type { ChatThreadKind, ThreadAction, ThreadMode, ThreadBackend } from '../common/thread-jobs';
import { THREAD_LIMITS } from '../common/thread-jobs';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { threadAuditKey } from './thread-audit';
import { readApprovalDecision } from './thread-decision';

/** The states a thread's current job is no longer live in (job-state.ts owns these). Prisma's `notIn` wants a mutable list. */
const TERMINAL_JOB_STATES: string[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'];

/** A stored `PROJECT` or `WORKSPACE` reads as itself; anything else (missing on old rows, or unknown) is a REPO thread. */
const mapThreadKind = (kind: string | null | undefined): ChatThreadKind =>
  (kind === 'PROJECT' || kind === 'WORKSPACE' ? kind : 'REPO');

/** A budget refusal carries the paused policy so the 409 names its scope. */
type SendRefusalResult = { refusal: 'budgetPaused'; pausedPolicy: BudgetPolicyRecord } | { refusal: Exclude<ThreadSendRefusal, 'budgetPaused'> | null; pausedPolicy: null };

/** A runner row that stored no capabilities hosts nothing: every thread rule misfits on it. */
const NO_CAPABILITIES = { threadBackends: undefined } as unknown as RunnerCapabilities;

/** #436: what hosting this stored thread needs from the fleet: its backend, its kind and its mode. */
const serveNeedOf = (thread: { kind: string | null; mode: string | null; backend: unknown }): ThreadServeNeed => ({
  backend: thread.backend as ThreadBackend,
  kind: mapThreadKind(thread.kind),
  mode: (thread.mode ?? 'read') as ThreadMode,
});

/** Shared visibility fence, applied before and after acquiring mutation locks. */
const scopeWhere = (scope: ThreadScope): Prisma.ChatThreadWhereInput => scope.kind === 'project'
  ? { projectId: scope.projectId, kind: { not: 'WORKSPACE' } }
  : { createdById: scope.userId, kind: 'WORKSPACE' };
const homeProjectInclude = (scope: ThreadScope) => scope.kind === 'workspace'
  ? { project: { select: { slug: true, name: true } } } as const : undefined;

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
    private readonly audit: AuditRecorder,
    private readonly threadEvents: ThreadEventBus,
  ) {}

  /**
   * US-001 (#424): the misfit of the runner that got furthest, by placement's own thread rules. Every enabled
   * thread-capable runner is judged (online or not); a runner that fits answers null, so a thread is refused only
   * when no runner can host it.
   *
   * A `runnerId` narrows the judgement to that runner alone (any `enabled` value — a thread's own runner is judged
   * even when it is disabled, because every later turn is pinned to it), and `modesOnly` judges the mode rule alone,
   * so a backend the runner no longer offers never refuses a mode change.
   *
   * #399: with no thread-capable runner enrolled, the fleet is not set up yet and there is nothing to judge against;
   * the thread is accepted and queues as before. Stored capabilities were validated by parseCapabilities at enroll/sync.
   */
  async threadServeMisfit(need: ThreadServeNeed): Promise<ThreadCapabilityMisfit | null> {
    const runners = await this.prisma.client.runner.findMany({
      where: need.runnerId
        ? { id: need.runnerId }
        : { enabled: true, protocolVersion: { gte: THREAD_MIN_PROTOCOL_VERSION } },
      select: { capabilities: true },
    });
    if (runners.length === 0) return null;
    let furthest: ThreadCapabilityMisfit | null = null;
    for (const runner of runners) {
      const capabilities = (runner.capabilities as unknown as RunnerCapabilities | null) ?? NO_CAPABILITIES;
      const misfit = need.modesOnly
        ? threadModeMisfit(need.mode, capabilities)
        : threadCapabilityMisfit({ backend: need.backend, kind: need.kind, mode: need.mode, enabled: true, action: 'SESSION' }, capabilities);
      // One runner that can host the thread is enough.
      if (misfit === null) return null;
      if (furthest === null || THREAD_MISFIT_ORDER[misfit] > THREAD_MISFIT_ORDER[furthest]) furthest = misfit;
    }
    return furthest;
  }

  async create(input: { mode?: ThreadMode; kind: ChatThreadKind; projectId: string; repoId: string | null; baseRef: string | null; feature: string | null; title: string; createdById: string; backend: ThreadBackend; skills: ThreadSkillSource[]; maxCostUsd: string }): Promise<ChatThreadRecord> {
    const row = await this.audit.audited(
      () => this.prisma.client.chatThread.create({ data: {
      kind: input.kind,
      mode: input.mode ?? 'read',
      projectId: input.projectId,
      repoId: input.repoId,
      baseRef: input.baseRef,
      feature: input.feature,
      title: input.title,
      createdById: input.createdById,
      // Permissions P1 US-001: the creator's type comes from the action context, so an agent's request (whose context
      // the global interceptor set) creates an AGENT thread; anything else is a user's.
      createdByType: actorTypeFor(input.createdById),
      backend: input.backend as Prisma.InputJsonValue,
      skills: input.skills as unknown as Prisma.InputJsonValue,
      // 1a-R4: a REPO thread's spec lives at .nax/features/<feature>/spec.md; a PROJECT thread has no repo, no feature
      // and no spec.
      specPath: input.kind === 'PROJECT' || input.feature === null ? null : `.nax/features/${input.feature}/spec.md`,
      maxCostUsd: input.maxCostUsd,
      } }),
      (created) => ({
        key: threadAuditKey('create', input.kind === 'WORKSPACE'),
        resourceType: 'thread',
        resourceId: created.id,
        projectId: created.projectId,
        summary: `created ${input.kind}`,
      }),
    );
    return this.mapThread(row, null);
  }

  async list(scope: ThreadScope, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]> {
    const rows = await this.prisma.client.chatThread.findMany({ where: { ...scopeWhere(scope), ...(status ? { status } : {}) }, include: homeProjectInclude(scope), skip, take, orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }] });
    const jobs = rows.length ? await this.prisma.client.fleetJob.findMany({ where: { threadId: { in: rows.map((row) => row.id) }, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true, threadId: true } }) : [];
    const active = new Map<string, { id: string; state: string }>();
    for (const job of jobs) if (job.threadId && !active.has(job.threadId)) active.set(job.threadId, { id: job.id, state: job.state });
    return rows.map((row) => this.mapThread(row, active.get(row.id) ?? null));
  }

  async get(scope: ThreadScope, id: string): Promise<ChatThreadRecord | null> {
    const row = await this.prisma.client.chatThread.findFirst({ where: { id, ...scopeWhere(scope) }, include: homeProjectInclude(scope) });
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

  /**
   * S5b 2a-D12: the thread's open actions for its detail. Newest decisions are already gone from the list, so the
   * reader sees exactly what can still be decided, oldest first; the cap is the same one propose enforces, so the
   * list can never grow past what one thread may hold. The slug comes from each action's own `projectId` — a
   * WORKSPACE thread's action that acts in another project answers that project's slug, not the thread's home.
   * The scope fence is part of the query (M1): a thread outside `scope` matches no row, so a caller that never ran
   * `get` first still cannot read a preview it may not see.
   */
  async pendingActions(scope: ThreadScope, threadId: string): Promise<ChatThreadPendingAction[]> {
    const rows = await this.prisma.client.assistantActionRequest.findMany({
      where: { threadId, request: { status: 'pending' }, thread: scopeWhere(scope) },
      orderBy: [{ createdAt: 'asc' }, { requestId: 'asc' }],
      take: MAX_PENDING_ACTIONS,
      select: {
        requestId: true, tool: true, preview: true, createdAt: true,
        request: { select: { id: true, projectId: true, expiresAt: true } },
      },
    });
    if (rows.length === 0) return [];
    const projectIds = [...new Set(rows.flatMap((row) => row.request.projectId ? [row.request.projectId] : []))];
    const projects = projectIds.length === 0 ? [] : await this.prisma.client.project.findMany({
      where: { id: { in: projectIds } }, select: { id: true, slug: true },
    });
    const slugs = new Map(projects.map((project) => [project.id, project.slug]));
    return rows.map((row) => ({
      id: row.request.id, approvalId: row.request.id, tool: row.tool, preview: row.preview,
      projectSlug: row.request.projectId ? slugs.get(row.request.projectId) ?? '' : '',
      expiresAt: row.request.expiresAt, createdAt: row.createdAt,
    }));
  }

  async sendRefusalOf(projectId: string, thread: ChatThreadRecord): Promise<ThreadSendRefusal | null> {
    const job = await this.prisma.client.fleetJob.findFirst({
      where: { threadId: thread.id, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, leaseEpoch: true },
    });
    const result = await this.sendRefusalFor({
      id: thread.id, kind: thread.kind, status: thread.status, runnerId: thread.runnerId, repoId: thread.repoId, projectId,
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

  async lockForFlow(projectId: string, threadId: string): Promise<ChatThreadRecord | null> {
    await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
    const row = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
    return row ? this.mapThread(row, null) : null;
  }

  async setPreApproval(projectId: string, threadId: string, preApproval: ThreadPreApproval): Promise<ChatThreadRecord> {
    return this.txManager.run(async () => {
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (before.status === 'ARCHIVED') throw new ConflictAppException({}, 'threads.archived');
      const row = await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { preApproval: preApproval as unknown as Prisma.InputJsonValue } });
      await this.audit.record({ key: 'fleet.thread.preapprove', resourceType: 'thread', resourceId: row.id, projectId, summary: 'pre-approval set' });
      return this.mapThread(row, null);
    });
  }

  async clearPreApproval(projectId: string, threadId: string): Promise<boolean> {
    return this.txManager.run(async () => {
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (before.preApproval === null) return false;
      const row = await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { preApproval: Prisma.DbNull } });
      await this.audit.record({ key: 'fleet.thread.preapprove', resourceType: 'thread', resourceId: row.id, projectId, summary: 'pre-approval cleared' });
      return true;
    });
  }

  async consumePreApproval(threadId: string): Promise<void> {
    await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
    const row = await this.prisma.client.chatThread.findUnique({ where: { id: threadId }, select: { preApproval: true } });
    if (row && row.preApproval !== null) await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { preApproval: Prisma.DbNull } });
  }

  async updateCap(scope: ThreadScope, threadId: string, userId: string, maxCostUsd: string, canOperate = false): Promise<ChatThreadRecord> {
    const updated = await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (!canOperate && before.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      const job = await this.currentThreadJob(threadId);
      if (job) await this.jobs.lockById(job.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      if (!canOperate && thread.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      const row = await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { maxCostUsd } });
      await this.audit.record({ key: threadAuditKey('cap', scope.kind === 'workspace'), resourceType: 'thread', resourceId: row.id, projectId: row.projectId, summary: 'fields: maxCostUsd' });
      return this.mapThread(row, job);
    });
    return updated;
  }

  /** Mode, transcript note, audit and idle-session close are one write, with the same lock order as send. */
  async changeMode(projectId: string, threadId: string, actor: { id: string; type: 'USER' | 'AGENT' }, mode: ThreadMode, canOperate: boolean): Promise<ChatThreadRecord> {
    let notification: { messageId: string; runnerId: string | null } | null = null;
    const result = await this.txManager.run(async () => {
      const where = { id: threadId, ...scopeWhere({ kind: 'project', projectId }) };
      const before = await this.prisma.client.chatThread.findFirst({ where });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      const assertOwner = (thread: typeof before) => {
        if (!canOperate && (thread.createdById !== actor.id || thread.createdByType !== actor.type)) {
          throw new ForbiddenAppException({}, 'permissions');
        }
      };
      assertOwner(before);
      const current = await this.activeThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      assertOwner(thread);
      if (mapThreadKind(thread.kind) !== 'REPO' && mode !== 'read') throw new ValidationAppException({ reason: 'mode' }, 'threads.input');
      const active = await this.activeThreadJob(threadId);
      if ((current?.id ?? null) !== (active?.id ?? null)) throw new ConflictAppException({}, 'threads.busy');
      // A no-op is harmless even during a turn; it never closes or annotates the session.
      if (thread.mode === mode) return this.mapThread(thread, active);
      if (active && (active.command !== 'THREAD' || active.action !== 'SESSION')) throw new ConflictAppException({}, 'threads.busy');
      const { refusal } = await this.sendRefusalFor(thread, active);
      if (refusal === 'turnRunning') throw new ConflictAppException({}, 'threads.turnRunning');
      const close = active ? await this.prisma.client.fleetCommand.findFirst({ where: { jobId: active.id, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: active.leaseEpoch }, select: { id: true } }) : null;
      // Mode changes do not need send budget/runner eligibility, but those earlier send refusals must
      // not hide a queued/running turn. UPLOADING and a close already sent are closing, not new turns.
      const closing = active?.state === 'UPLOADING' || (active?.state === 'RUNNING' && close !== null);
      if (!closing && (active?.state === 'QUEUED' || active?.state === 'ASSIGNED' || await this.prisma.client.chatMessage.findFirst({ where: { threadId, status: { in: ['pending', 'streaming'] } }, select: { id: true } }))) {
        throw new ConflictAppException({}, 'threads.turnRunning');
      }
      let runnerId: string | null = null;
      if (active?.state === 'RUNNING' && active.runnerId && !close) {
        await this.jobs.createCommand({ runnerId: active.runnerId, jobId: active.id, type: FleetCommandType.THREAD_CLOSE, leaseEpoch: active.leaseEpoch, payload: {} });
        runnerId = active.runnerId;
      }
      const from = thread.mode;
      const row = await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { mode, lastActivityAt: new Date() } });
      const displayName = actor.type === 'AGENT'
        ? (await this.prisma.client.agent.findUnique({ where: { id: actor.id }, select: { name: true, slug: true } }))
        : (await this.prisma.client.user.findUnique({ where: { id: actor.id }, select: { name: true, email: true } }));
      const name = displayName?.name ?? (displayName && ('email' in displayName ? displayName.email : displayName.slug)) ?? actor.id;
      // Persist English transcript text (also consumed by agents), resolving the actor's name at write time.
      const content = threadMessages.modeChanged.replace('{from}', () => from).replace('{to}', () => mode).replace('{name}', () => name);
      const seq = await allocateThreadSeq(this.prisma.client, threadId);
      const message = await this.prisma.client.chatMessage.create({ data: { threadId, seq, role: 'system', status: 'complete', content } });
      await this.audit.record({ key: threadModeKey(mode), resourceType: 'thread', resourceId: threadId, projectId, summary: `mode changed from ${from} to ${mode}` });
      notification = { messageId: message.id, runnerId };
      return this.mapThread(row, active);
    });
    if (notification) {
      const { messageId, runnerId } = notification;
      if (runnerId) this.notifier.notify(runnerId);
      committedEffect(() => {
        const at = new Date().toISOString();
        this.threadEvents.publish({ id: randomUUID(), type: 'message', threadId, messageId, at });
        this.threadEvents.publish({ id: randomUUID(), type: 'thread', threadId, at });
      });
    }
    return result;
  }

  async command(scope: ThreadScope, threadId: string, userId: string, type: string, payload: object, canOperate = false): Promise<void> {
    let runnerId: string | null = null;
    await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      if (!canOperate && before.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      const current = await this.currentThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      if (!canOperate && thread.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      // US-008: an answer carries either a text or a decision, and each is checked against its own pending list —
      // a decision never satisfies a pending question, and a text answer never satisfies a pending approval.
      const answer = payload as { requestId?: unknown; decision?: unknown };
      const decision = type === FleetCommandType.THREAD_ANSWER ? readApprovalDecision(answer.decision) : null;
      if (type === FleetCommandType.THREAD_ANSWER) {
        if (decision !== null) {
          if (!readPendingApprovals(thread.pendingApprovals).some((row) => row.requestId === answer.requestId)) {
            throw new ConflictAppException({}, 'threads.noApproval');
          }
        } else {
          const question = thread.pendingQuestion as { requestId?: unknown } | null;
          if (!question || question.requestId !== answer.requestId) throw new ConflictAppException({}, 'threads.noQuestion');
        }
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
      // Permissions P1 US-002: an answer steers the live turn, so only the turn's requester may send it.
      if (type === FleetCommandType.THREAD_ANSWER) this.assertOwnLiveSession(job, userId);
      await this.jobs.createCommand({ runnerId: job.runnerId, jobId: job.id, type: type as FleetCommandType, leaseEpoch: job.leaseEpoch, payload });
      const action = type === FleetCommandType.THREAD_STOP_TURN ? 'stop'
        : type === FleetCommandType.THREAD_CLOSE ? 'end-session'
          : type === FleetCommandType.THREAD_ANSWER ? (decision === null ? 'answer' : 'approve') : null;
      if (action) await this.audit.record({
        key: threadAuditKey(action, scope.kind === 'workspace'), resourceType: 'thread', resourceId: thread.id,
        projectId: thread.projectId,
        // US-008: the decision's audit entry names which way it went, so the transcript says allow or deny.
        summary: action === 'stop' ? 'stop requested'
          : action === 'end-session' ? 'end requested'
            : action === 'approve' ? `decision ${decision} for ${String(answer.requestId)}` : 'answered',
      });
      runnerId = job.runnerId;
    });
    if (runnerId) this.notifier.notify(runnerId);
  }

  async unstartedTurnJob(scope: ThreadScope, threadId: string, userId: string, canOperate = false): Promise<UnstartedTurn | null> {
    const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) }, select: { createdById: true } });
    if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
    if (!canOperate && thread.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
    const job = await this.currentThreadJob(threadId);
    // C2-D7: only a SESSION turn is Stop's to end; a queued PUBLISH or DISCARD keeps answering noSession.
    if (!job || job.threadTurn?.action !== 'SESSION' || (job.state !== 'QUEUED' && job.state !== 'ASSIGNED')) return null;
    return { jobId: job.id, projectId: job.projectId };
  }

  async archive(scope: ThreadScope, threadId: string, userId: string, canArchive: boolean): Promise<string | null> {
    return this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      // Permissions P1 US-002: `canArchive` is the any-row `thread.archive` grant, never the project role.
      if (!canArchive && before.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      const current = await this.currentThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      if (thread.status === 'ARCHIVED') return null;
      const archived = await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await this.audit.record({ key: threadAuditKey('archive', scope.kind === 'workspace'), resourceType: 'thread', resourceId: archived.id, projectId: archived.projectId, summary: 'archived' });
      // A send that took the locks first may have created a job the pre-lock read never saw, so
      // the cancel target is read again under the thread row lock.
      return (await this.currentThreadJob(threadId))?.id ?? null;
    });
  }

  async publish(projectId: string, threadId: string, userId: string, canOperate = false): Promise<{ jobId: string | null }> {
    let notifyRunnerId: string | null = null;
    let placeJobId: string | null = null;
    const result = await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      // 1a-R3: Publish is REPO-only, and the guard runs before the creator check so a PROJECT thread answers 409.
      const repoFields = repoThreadFields(before);
      // Permissions P1 US-002: the any-row `thread.publish` holder publishes another creator's thread as itself.
      if (!canOperate && before.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      const current = await this.activeThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      const active = await this.activeThreadJob(threadId);
      if ((current?.id ?? null) !== (active?.id ?? null)) throw new ConflictAppException({}, 'threads.busy');
      if (!canOperate && thread.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
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
        // Permissions P1 US-002: publishing into a live turn steers it, so only the turn's requester may do it.
        this.assertOwnLiveSession(active, userId);
        await this.jobs.createCommand({ runnerId: active.runnerId, jobId: active.id, type: FleetCommandType.THREAD_PUBLISH, leaseEpoch: active.leaseEpoch, payload: {} });
        await this.audit.record({ key: threadAuditKey('publish', false), resourceType: 'thread', resourceId: thread.id, projectId: thread.projectId, summary: `publish into session ${active.id}` });
        notifyRunnerId = active.runnerId;
        return { jobId: null };
      }
      if (active) throw new ConflictAppException({}, 'threads.busy');
      // thread-agents-modes (branch fix B1): `writtenPaths` counts write_doc only, and an `ask`/`full` turn edits the
      // worktree through native Write/Edit/Bash or the ACP agent's own tools, so those modes publish the runner's own
      // diff and the API has nothing to count in advance. `read` keeps the guard: there is nothing else to publish.
      if (thread.mode === 'read' && thread.writtenPaths.length === 0) throw new ConflictAppException({}, 'threads.nothingToPublish');
      const job = await this.createThreadJob(thread, 'PUBLISH', undefined, undefined, { id: userId, type: actorTypeFor(userId) });
      await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
      await this.activity.record({ actorType: 'USER', actorId: userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id, projectId: thread.projectId, responsibleUserId: userId, payload: { repoId: repoFields.repoId, feature: `thread-${thread.id}`, command: 'THREAD', ref: repoFields.baseRef } });
      await this.audit.record({ key: threadAuditKey('publish', false), resourceType: 'thread', resourceId: thread.id, projectId: thread.projectId, summary: `publish job ${job.id}` });
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
  async discard(projectId: string, threadId: string, userId: string, canOperate = false): Promise<{ jobId: string }> {
    let placeJobId: string | null = null;
    const result = await this.txManager.run(async () => {
      const before = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
      if (!before) throw new NotFoundAppException({}, 'threads.notFound');
      // 1a-R3: Discard is REPO-only, and the guard runs before the creator check so a PROJECT thread answers 409.
      const repoFields = repoThreadFields(before);
      if (!canOperate && before.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
      const current = await this.activeThreadJob(threadId);
      if (current) await this.jobs.lockById(current.id);
      await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const thread = await this.prisma.client.chatThread.findFirst({ where: { id: threadId, projectId, kind: { not: 'WORKSPACE' } } });
      if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
      const active = await this.activeThreadJob(threadId);
      if ((current?.id ?? null) !== (active?.id ?? null)) throw new ConflictAppException({}, 'threads.busy');
      if (!canOperate && thread.createdById !== userId) throw new ForbiddenAppException({}, 'permissions');
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
      const job = await this.createThreadJob(thread, 'DISCARD', undefined, undefined, { id: userId, type: actorTypeFor(userId) });
      await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
      await this.activity.record({ actorType: 'USER', actorId: userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id, projectId: thread.projectId, responsibleUserId: userId, payload: { repoId: repoFields.repoId, feature: `thread-${thread.id}`, command: 'THREAD', ref: repoFields.baseRef } });
      await this.audit.record({ key: threadAuditKey('discard', false), resourceType: 'thread', resourceId: thread.id, projectId: thread.projectId, summary: `discard job ${job.id}` });
      placeJobId = job.id;
      return { jobId: job.id };
    });
    if (placeJobId) await this.placement.placeJob(placeJobId);
    return result;
  }

  async sendMessage(input: { scope: ThreadScope; threadId: string; userId: string; text: string; clientMessageId: string; repoContext?: string; canOperate?: boolean; assertServed?: (need: ThreadServeNeed) => Promise<void> }): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }> {
    // Permissions P1 US-002: ownership comes from the keys. An any-row `thread.message.send` holder sends into
    // another creator's thread; a `.own` holder (or the unchanged workspace callers, which pass no flag) keeps the
    // creator compare.
    const canOperate = input.canOperate === true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.txManager.run(async () => {
        const threadBefore = await this.prisma.client.chatThread.findFirst({ where: { id: input.threadId, ...scopeWhere(input.scope) } });
        if (!threadBefore) throw new NotFoundAppException({}, 'threads.notFound');
        if (!canOperate && threadBefore.createdById !== input.userId) throw new ForbiddenAppException({}, 'permissions');
        const duplicate = await this.prisma.client.chatMessage.findUnique({ where: { threadId_clientMessageId: { threadId: input.threadId, clientMessageId: input.clientMessageId } } });
        if (duplicate) return { kind: 'done' as const, result: { message: this.mapMessage(duplicate), jobId: null, deduplicated: true } };

        const currentJob = await this.currentThreadJob(input.threadId);
        if (currentJob) await this.jobs.lockById(currentJob.id);
        await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${input.threadId} FOR UPDATE`;
        const thread = await this.prisma.client.chatThread.findFirst({ where: { id: input.threadId, ...scopeWhere(input.scope) } });
        if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
        const currentAfterLock = await this.currentThreadJob(input.threadId);
        if ((currentJob?.id ?? null) !== (currentAfterLock?.id ?? null)) return { kind: 'retry' as const };
        if (!canOperate && thread.createdById !== input.userId) throw new ForbiddenAppException({}, 'permissions');
        const duplicateAfterLock = await this.prisma.client.chatMessage.findUnique({ where: { threadId_clientMessageId: { threadId: input.threadId, clientMessageId: input.clientMessageId } } });
        if (duplicateAfterLock) return { kind: 'done' as const, result: { message: this.mapMessage(duplicateAfterLock), jobId: null, deduplicated: true } };

        const refused = await this.sendRefusalFor(thread, currentAfterLock);
        if (refused.refusal === 'budgetPaused') throw new BudgetPausedException(refused.pausedPolicy);
        if (refused.refusal) throw this.refusalException(refused.refusal);
        const active = await this.activeThreadJob(thread.id);
        if (active && (active.command !== 'THREAD' || active.action === 'PUBLISH' || active.action === 'DISCARD')) {
          throw new ConflictAppException({}, 'threads.busy');
        }
        // Permissions P1 US-002: input that steers a live turn comes from the turn's requester, and this refusal
        // runs before the sequence is allocated so a refused send writes nothing at all.
        this.assertOwnLiveSession(currentAfterLock, input.userId);
        // #436: a send that would queue a new turn is refused when no runner can host the thread's backend, mode or kind.
        // Like every refusal above it runs before the sequence is allocated, so a refused send writes nothing.
        const feedsLiveSession = currentAfterLock?.state === 'RUNNING' && Boolean(currentAfterLock.runnerId);
        if (input.assertServed && !feedsLiveSession) await input.assertServed(serveNeedOf(thread));

        // A completed out-of-band message can sit at or above the counter, so the shared allocator takes the higher.
        const seq = await allocateThreadSeq(this.prisma.client, thread.id);
        const messageRow = await this.prisma.client.chatMessage.create({ data: {
          threadId: thread.id, seq, role: 'user', status: 'pending', authorUserId: input.userId,
          // Permissions P1 US-001: the sender's type from the action context; an agent's send is the agent's message.
          authorType: actorTypeFor(input.userId),
          clientMessageId: input.clientMessageId, content: input.text,
        } });
        await this.prisma.client.chatThread.update({ where: { id: thread.id }, data: { lastActivityAt: new Date() } });
        const message = this.mapMessage(messageRow);
        // 2aw-D3: the outcome hand-off, inside the same transaction, after the message exists and before either
        // branch. The stored message keeps the plain `input.text`.
        const handoffText = await this.deliverOutcomeNotes(thread.id, message.id, input.text);
        // The refusal gate passed, so a RUNNING job here is a live session with no turn in flight.
        if (currentAfterLock?.state === 'RUNNING' && currentAfterLock.runnerId) {
          await this.jobs.createCommand({ runnerId: currentAfterLock.runnerId, jobId: currentAfterLock.id, type: FleetCommandType.THREAD_INPUT, leaseEpoch: currentAfterLock.leaseEpoch, payload: { messageId: message.id, text: handoffText } });
          await this.audit.record({ key: threadAuditKey('message', input.scope.kind === 'workspace'), resourceType: 'thread', resourceId: thread.id, projectId: thread.projectId, summary: `message ${message.id}` });
          return { kind: 'done' as const, result: { message, jobId: null, deduplicated: false }, notifyRunnerId: currentAfterLock.runnerId };
        }

        const job = await this.createThreadJob(thread, 'SESSION', message, input.repoContext, { id: input.userId, type: actorTypeFor(input.userId) });
        await this.prisma.client.chatMessage.update({ where: { id: message.id }, data: { jobId: job.id, turnId: job.id } });
        const linkedMessage = { ...message, jobId: job.id, turnId: job.id };
        await this.jobs.appendEvent(job.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        // The job names where it runs: a PROJECT thread's job carries the anchor repo, not the thread's null repo fields.
        await this.activity.record({ actorType: 'USER', actorId: input.userId, action: 'job.dispatched', entityType: 'job', entityId: job.id, jobId: job.id,
          projectId: thread.projectId, responsibleUserId: input.userId, payload: { repoId: job.repoId, feature: `thread-${thread.id}`, command: 'THREAD', ref: job.ref } });
        await this.audit.record({ key: threadAuditKey('message', input.scope.kind === 'workspace'), resourceType: 'thread', resourceId: thread.id, projectId: thread.projectId, summary: `message ${message.id}, job ${job.id}` });
        return { kind: 'done' as const, result: { message: linkedMessage, jobId: job.id, deduplicated: false }, placeJobId: job.id };
      });
      if (outcome.kind === 'retry') continue;
      if (outcome.notifyRunnerId) this.notifier.notify(outcome.notifyRunnerId);
      if (outcome.placeJobId) await this.placement.placeJob(outcome.placeJobId);
      return outcome.result;
    }
    throw new ConflictAppException({}, 'threads.turnRunning');
  }

  /**
   * 2aw-D3: the outcome hand-off. This thread's undelivered terminal actions are read in age order, at most
   * `MAX_DELIVERED_NOTES` of them; their notes (`outcomeNote`) are folded into the byte-bounded delivery text
   * (`deliveryText`) and the first `delivered` of them are marked on this message in one update. A note is therefore
   * handed over exactly once: a new-turn job rebuilds the same text from `deliveredMessageId` (2aw-D4), and a send
   * that never reaches this point — a duplicate `clientMessageId`, a refusal — delivers nothing. Answers the text the
   * runner path carries: `userText` itself when no note fits or none is undelivered.
   */
  private async deliverOutcomeNotes(threadId: string, messageId: string, userText: string): Promise<string> {
    const links = await this.prisma.client.assistantActionRequest.findMany({
      where: { threadId, deliveredAt: null, request: { status: { in: [...DELIVERABLE_STATUSES] } } },
      orderBy: [{ createdAt: 'asc' }, { requestId: 'asc' }],
      take: MAX_DELIVERED_NOTES,
      select: { requestId: true, tool: true, request: { select: { status: true, result: true } } },
    });
    const notes = links.map((link) => requestOutcomeNote({
      requestId: link.requestId,
      tool: link.tool,
      status: link.request.status as (typeof DELIVERABLE_STATUSES)[number],
      result: link.request.result,
    }));
    const { text, delivered } = deliveryText(notes, userText, THREAD_LIMITS.messageMaxBytes);
    if (delivered > 0) {
      await this.prisma.client.assistantActionRequest.updateMany({
        where: { requestId: { in: links.slice(0, delivered).map((link) => link.requestId) }, deliveredAt: null },
        data: { deliveredAt: new Date(), deliveredMessageId: messageId },
      });
    }
    return text;
  }

  /** The facts `sendRefusal` judges, read under the thread and job locks. Writes nothing. */
  private async sendRefusalFor(thread: { id: string; kind?: string; status: string; costUsd: Prisma.Decimal; maxCostUsd: Prisma.Decimal; runnerId: string | null; projectId: string; repoId: string | null }, job: { id: string; state: string; leaseEpoch: number } | null): Promise<SendRefusalResult> {
    // PROJECT and WORKSPACE threads own no repo, so their budget gate uses the home project's anchor (S5b-R13);
    // a project without a fleet repo gates no repo scope at all. The missing anchor is not a send refusal (US-004).
    const gateRepoId = mapThreadKind(thread.kind) !== 'REPO' ? (await this.anchorRepoFor(thread.projectId))?.id ?? null : thread.repoId;
    const pauses = await this.budgets.snapshot(new Date());
    const pausedPolicy = pauses.match(jobGateKeys({ projectId: thread.projectId, repoId: gateRepoId, pinnedRunnerId: thread.runnerId }));
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
   * Creates a thread's THREAD job and its turn. A REPO thread runs on its own repo and is told to draft the feature's
   * spec there; a PROJECT thread has no repo to check out, so its job lands on the project's anchor repo — bookkeeping
   * for placement, budgets, dashboards and activity (S5b-R13) — and is told it has no repository. A project with no
   * fleet repo cannot run one: 409 `threads.noFleetRepo`.
   *
   * `repoContext` is the repository section `ThreadsService` resolved before the transaction (1c-D1); only a SESSION
   * passes it, so a PUBLISH or DISCARD turn keeps today's instructions.
   *
   * `requester` is who asked for this turn (permissions P1 US-001): the message's sender, or the caller of `publish` or
   * `discard`. It is never the thread's creator — an agent may send into, publish or discard a thread a user created —
   * so the job's `requestedById`/`requestedByType` name the requester and every reader of them (outcome notifications,
   * PR attribution, `responsibleUserOf`) judges that principal.
   */
  private async createThreadJob(thread: Prisma.ChatThreadGetPayload<object>, action: ThreadAction, message: ChatMessageRecord | undefined, repoContext: string | undefined, requester: { id: string; type: ActorType }) {
    const skills = thread.skills as unknown as ThreadSkillSource[];
    const backend = thread.backend as unknown as ThreadBackend;
    const target = await this.jobTargetFor(thread, repoContext);
    const previousSession = action === 'SESSION' ? await this.prisma.client.fleetThreadTurn.findFirst({ where: { threadId: thread.id, action: 'SESSION' }, select: { jobId: true } }) : null;
    const remaining = new Prisma.Decimal(thread.maxCostUsd).minus(thread.costUsd);
    let job;
    try {
      job = await this.jobs.createJob({
        projectId: thread.projectId, repoId: target.repoId, ref: target.ref, command: 'THREAD', threadId: thread.id,
        feature: `thread-${thread.id}`, planFrom: null, profiles: [], maxCostUsd: action === 'SESSION' ? remaining.toString() : '0', bashMode: 'raw',
        approvalTimeoutSec: DEFAULT_APPROVAL_TIMEOUT_SEC, selectorLabels: [], pinnedRunnerId: thread.runnerId,
        requestedById: requester.id, requestedByType: requester.type,
      });
    } catch (error) {
      if (error instanceof DuplicateActiveJobError) throw new ConflictAppException({}, action === 'SESSION' ? 'threads.turnRunning' : 'threads.busy');
      throw error;
    }
    await this.prisma.client.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action, initialMessageId: message?.id ?? null, instructions: target.instructions,
      backend: backend as Prisma.InputJsonValue, skills: skills as unknown as Prisma.InputJsonValue,
      mode: thread.mode,
      resume: action === 'SESSION' && previousSession !== null,
    } });
    return job;
  }

  /** Job bookkeeping uses the thread's own repo, or the home anchor for PROJECT/WORKSPACE; only REPO gets a checkout. */
  private async jobTargetFor(thread: Prisma.ChatThreadGetPayload<object>, repoContext?: string): Promise<{ repoId: string; ref: string; instructions: string }> {
    const skills = thread.skills as unknown as ThreadSkillSource[];
    if (mapThreadKind(thread.kind) === 'WORKSPACE') {
      const anchor = await this.anchorRepoFor(thread.projectId);
      if (!anchor) throw new ConflictAppException({}, 'threads.noFleetRepo');
      return { repoId: anchor.id, ref: anchor.defaultBranch, instructions: buildWorkspaceThreadInstructions({ skills }) };
    }
    if (mapThreadKind(thread.kind) === 'PROJECT') {
      const anchor = await this.anchorRepoFor(thread.projectId);
      if (!anchor) throw new ConflictAppException({}, 'threads.noFleetRepo');
      const project = await this.prisma.client.project.findUnique({ where: { id: thread.projectId }, select: { slug: true, brief: true } });
      if (!project) throw new NotFoundAppException({}, 'projects');
      return { repoId: anchor.id, ref: anchor.defaultBranch, instructions: buildProjectThreadInstructions({ project: project.slug, skills, brief: this.briefBlock(project.brief, repoContext) }) };
    }
    const { repoId, baseRef, feature, specPath } = repoThreadFields(thread);
    const repo = await this.prisma.client.fleetRepo.findUnique({ where: { id: repoId }, select: { owner: true, name: true } });
    if (!repo) throw new NotFoundAppException({}, 'fleet.repos');
    return { repoId, ref: baseRef, instructions: buildThreadInstructions({ repo: `${repo.owner}/${repo.name}`, baseRef, feature, specPath, skills, mode: (thread.mode ?? 'read') as ThreadMode, brief: await this.readBriefBlock(thread.projectId, repoContext) }) };
  }

  /**
   * The L0 brief block of a turn that carries a repository context section (1c-D1): the project's brief and the
   * section, rendered here, inside the transaction — the brief is a database read. A turn without a section (a
   * PUBLISH or DISCARD job) gets no block, so its instructions are exactly as before.
   */
  private briefBlock(brief: string | null, repoContext: string | undefined): string | undefined {
    return repoContext === undefined ? undefined : renderBriefBlock({ brief, repoContext });
  }

  /** The block for a REPO thread, whose project row is not read for anything else: no section, no brief read. */
  private async readBriefBlock(projectId: string, repoContext: string | undefined): Promise<string | undefined> {
    if (repoContext === undefined) return undefined;
    const project = await this.prisma.client.project.findUnique({ where: { id: projectId }, select: { brief: true } });
    return this.briefBlock(project?.brief ?? null, repoContext);
  }

  /**
   * The project's anchor repo (S5b-R13), with the same rule as `IFleetRepoRepository.findAnchor`: the oldest repo by
   * `createdAt`, ties broken by the smallest `id`. The anchor is bookkeeping only — placement, budget keys, dashboards
   * and activity — and the runner neither clones nor fetches it.
   */
  private anchorRepoFor(projectId: string) {
    return this.prisma.client.fleetRepo.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, defaultBranch: true },
    });
  }

  private async currentThreadJob(threadId: string) {
    return this.prisma.client.fleetJob.findFirst({
      where: { threadId, command: 'THREAD', state: { notIn: TERMINAL_JOB_STATES } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      // Permissions P1 US-002: the requester and the turn's action decide whether this is a live session someone
      // else started, which input-bearing calls must not steer.
      select: {
        id: true, projectId: true, state: true, runnerId: true, leaseEpoch: true, requestedById: true, requestedByType: true,
        threadTurn: { select: { action: true } },
      },
    });
  }

  /**
   * Permissions P1 US-002: a live session belongs to its requester. Input that steers a running turn — a message,
   * an answer, an in-session publish — must come from the principal that started it, because that turn's tools check
   * its keys and its writes are recorded as its own. A job with no turn, or a turn that is not a SESSION, is not a
   * live session for this rule, and stop/end-session carry no input and are not checked. The refusal is 409
   * `threads.sessionOtherPrincipal`: the sender ends the session first (`end-session`, which an any-row holder may do).
   */
  private assertOwnLiveSession(
    job: { state: string; requestedById: string; requestedByType: string; threadTurn?: { action: string } | null } | null,
    actorId: string,
  ): void {
    if (!job || job.state !== 'RUNNING' || job.threadTurn?.action !== 'SESSION') return;
    // The type is compared too: the action context says which principal the id names in this request.
    if (job.requestedById === actorId && job.requestedByType === actorTypeFor(actorId)) return;
    throw new ConflictAppException({}, 'threads.sessionOtherPrincipal');
  }

  /** Strips the fold-internal columns (`threadId`, `streamRound`, `streamRoundStart`) that never leave the API. */
  private mapMessage(row: Prisma.ChatMessageGetPayload<object>): ChatMessageRecord {
    const { threadId: _threadId, streamRound: _streamRound, streamRoundStart: _streamRoundStart, ...message } = row;
    return { ...message, costUsd: row.costUsd?.toString() ?? null };
  }

  private mapThread(row: Prisma.ChatThreadGetPayload<object> & { project?: { slug: string; name: string } }, activeJob: { id: string; state: string } | null): ChatThreadRecord {
    return {
      mode: (row.mode ?? 'read') as ThreadMode,
      id: row.id, kind: mapThreadKind(row.kind), projectId: row.projectId,
      ...(row.project ? { homeProject: row.project } : {}),
      repoId: row.repoId, baseRef: row.baseRef, feature: row.feature,
      title: row.title, createdById: row.createdById, createdByType: row.createdByType as 'USER' | 'AGENT', runnerId: row.runnerId,
      backend: row.backend as unknown as ThreadBackend, status: row.status, archivedAt: row.archivedAt,
      skills: row.skills as unknown as ThreadSkillSource[], maxCostUsd: row.maxCostUsd.toString(),
      costUsd: row.costUsd.toString(), tokens: row.tokens, specPath: row.specPath,
      pendingQuestion: row.pendingQuestion, session: (row.session as unknown as ThreadSession | null) ?? null,
      pendingApprovals: readPendingApprovals(row.pendingApprovals),
      lastActivityAt: row.lastActivityAt, createdAt: row.createdAt, activeJob,
      writtenPaths: row.writtenPaths, publishedSha: row.publishedSha, specPublished: row.specPublished,
      preApproval: (row.preApproval as unknown as ThreadPreApproval | null) ?? null,
      lastWrite: (row.lastWrite as unknown as ThreadWriteResult | null) ?? null,
    };
  }
}
