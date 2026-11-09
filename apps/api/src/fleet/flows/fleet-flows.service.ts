import { posix } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { canTransitionFlow } from './flow-states';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { ApprovalAskService } from '../../approvals/approval-ask.service';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { Prisma } from '../../generated/prisma/client';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FleetReposService } from '../repos/fleet-repos.service';
import { repoThreadFields } from '../threads/domain/chat-thread.domain';
import { ThreadsService } from '../threads/threads.service';
import type { ThreadSpecPublishedEvent } from '../threads/ingest/thread-spec-published.event';
import { GIT_REF_RE } from '../jobs/dispatch-input';
import {
  FLEET_FLOW_REPOSITORY,
  type FleetFlowEntry,
  type FleetFlowRecord,
  type IFleetFlowRepository,
} from './domain/fleet-flow.domain';
import type { FlowAnswersInput } from './flow-answers';
import type { NormalizedFlowFeature } from './flow-input';

const SPEC_SHA_RE = /^[a-f0-9]{40}$/;

/** Who asked for the flow: the principal the start request is opened on behalf of. */
export interface FlowCreator { type: 'USER' | 'AGENT'; id: string }

/** The validated create body (US-006) plus the entry-specific fields each route resolves. */
export interface CreateFlowInput {
  entry: FleetFlowEntry;
  /** THREAD entry: the thread whose publish record the flow pins. */
  threadId?: string;
  /** NAX entry: the repo the caller resolved from `remoteUrl`, and the branch and sha it pins. */
  repoId?: string;
  branch?: string;
  specSha?: string;
  features: NormalizedFlowFeature[];
  roles: { reviewer: string; supervisor: string };
  costCapUsd: string;
}

/** The route's own facts: the project it resolved, and a clock a test can pin. */
export interface CreateFlowContext { projectId: string; now?: Date }

export interface CreatedFlow { flow: FleetFlowRecord; approvalRequestId: string | null }

/** The branch, sha and runner a flow pins, plus the tick that may start it without an approval. */
interface FlowTarget {
  projectId: string;
  repoId: string;
  threadId: string | null;
  branch: string;
  specSha: string;
  pinnedRunnerId: string | null;
  /** A tick that covers this flow; null when the flow must ask. */
  tick: { userId: string } | null;
}

/**
 * Fleet flow F1 (US-007): the one create both entries share.
 *
 * One transaction per create: lock the thread (thread entry) or the `FleetRepo` (nax entry), refuse a
 * second live flow, insert the flow and its features, then either consume the thread's covering tick
 * or open the `fleet.flow.start` ask on the creator's behalf. The ask is opened programmatically — the
 * approval gate would execute a human caller's action at once, so a flow could never stay PENDING
 * through `routeGate.run` alone (the `openBudget` precedent) — and it commits with the flow, so a
 * failing ask leaves no flow behind.
 */
@Injectable()
export class FleetFlowsService {
  constructor(
    @Inject(FLEET_FLOW_REPOSITORY) private readonly flows: IFleetFlowRepository,
    private readonly threads: ThreadsService,
    private readonly repos: FleetReposService,
    private readonly asks: ApprovalAskService,
    private readonly audit: AuditRecorder,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  list(projectId: string, page: IPageOption, filters: { threadId?: string } = {}): Promise<IPageResult<FleetFlowRecord>> {
    return this.flows.findPage({ projectId, ...(filters.threadId ? { threadId: filters.threadId } : {}) }, page);
  }

  /** Global readers resolve project reach before returning this record to the caller. */
  async findById(id: string): Promise<FleetFlowRecord> {
    const flow = await this.flows.findById(id);
    if (!flow) throw new NotFoundAppException({}, 'fleet.flows.notFound');
    return flow;
  }

  async get(projectId: string, id: string): Promise<FleetFlowRecord> {
    const flow = await this.findById(id);
    if (flow.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.flows.notFound');
    return flow;
  }

  async answer(projectId: string, id: string, input: FlowAnswersInput, actor: { type: 'USER'; id: string }, now = new Date()): Promise<FleetFlowRecord> {
    return this.txManager.run(async () => {
      // The initial read selects only the parent lock. The flow's project and answer state are
      // re-read after acquiring locks in the same parent-before-flow order as stop/create.
      const target = await this.get(projectId, id);
      if (target.threadId !== null) await this.threads.lockForFlowTransition(projectId, target.threadId);
      else await this.repos.lockById(target.repoId);
      const flow = await this.flows.lockById(id);
      if (!flow || flow.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.flows.notFound');
      if (flow.state !== 'WAITING_ANSWER') throw new ConflictAppException({}, 'fleet.flows.notWaiting');

      const feature = flow.features.find(({ state }) => state === 'WAITING_ANSWER');
      if (!feature || feature.questions === null || feature.questions === undefined) {
        throw new ConflictAppException({}, 'fleet.flows.notWaiting');
      }
      if (feature.questionsJobId !== input.jobId) throw new ConflictAppException({}, 'fleet.flows.answersStale');

      const answersById = new Map(input.answers.map((answer) => [answer.id, answer]));
      const questionIds = new Set(feature.questions.map(({ id: questionId }) => questionId));
      for (const answer of input.answers) {
        if (!questionIds.has(answer.id)) {
          throw new ValidationAppException({ reason: `unknown question ${answer.id}` }, 'fleet.flows.answersInput');
        }
      }
      const orderedAnswers = feature.questions.map(({ id: questionId }) => {
        const answer = answersById.get(questionId);
        if (!answer) throw new ValidationAppException({ reason: `missing answer ${questionId}` }, 'fleet.flows.answersInput');
        return answer;
      });
      const answered = await this.flows.recordAnswers(flow.id, feature.id, { answers: orderedAnswers, userId: actor.id, at: now });
      await this.audit.record({
        key: 'fleet.flow.answer', resourceType: 'flow', resourceId: flow.id, projectId,
        summary: 'flow answered',
      });
      await this.activity.record({
        actorType: actor.type, actorId: actor.id, action: 'flow.answered', entityType: 'flow',
        entityId: flow.id, projectId, payload: { flowId: flow.id, jobId: input.jobId, count: orderedAnswers.length },
      });
      return answered;
    });
  }

  async stop(projectId: string, id: string, actor: FlowCreator, now = new Date()): Promise<FleetFlowRecord> {
    return this.txManager.run(async () => {
      // Only use the unlocked lookup to select the parent lock. State is read again under the flow
      // lock, after the parent, just as create and re-publish serialise on that parent first.
      const target = await this.get(projectId, id);
      if (target.threadId !== null) await this.threads.lockForFlowTransition(projectId, target.threadId);
      else await this.repos.lockById(target.repoId);
      const flow = await this.flows.lockById(id);
      if (!flow || flow.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.flows.notFound');
      if (!canTransitionFlow(flow.state, 'STOPPED')) throw new ConflictAppException({}, 'fleet.flows.notStoppable');
      const stopped = await this.flows.stop(flow.id, 'human_stop', now);
      // A decision may already hold the ask. SKIP LOCKED returning null is fine: the start command
      // re-reads the terminal flow and cannot approve it after this transaction commits.
      if (flow.approvalRequestId !== null) {
        await this.asks.close(flow.approvalRequestId, { status: 'cancelled', reason: 'flow_stopped' }, now);
      }
      await this.audit.record({
        key: 'fleet.flow.stop', resourceType: 'flow', resourceId: flow.id, projectId,
        summary: 'flow stopped',
      });
      await this.activity.record({
        actorType: actor.type, actorId: actor.id, action: 'flow.stopped', entityType: 'flow',
        entityId: flow.id, projectId, payload: { flowId: flow.id, stopReason: 'human_stop' },
      });
      return stopped;
    });
  }

  /** Re-evaluate a committed publication. Later-state coordination belongs to F3. */
  async respec(event: ThreadSpecPublishedEvent): Promise<void> {
    // The unlocked lookup selects the project/flow only; state and sha are re-read under locks.
    const target = await this.flows.findLiveForThread(event.threadId);
    if (!target) return;
    await this.txManager.run(async () => {
      const thread = await this.threads.lockForFlowTransition(target.projectId, event.threadId);
      const flow = await this.flows.lockById(target.id);
      if (!thread || !flow || flow.projectId !== target.projectId || flow.threadId !== event.threadId) return;
      if (event.sha !== thread.publishedSha || event.sha === flow.specSha) return;
      if (flow.state !== 'PENDING' && flow.state !== 'APPROVED') return;

      // Paths describe only this publication, not any intervening ones. A stale/skipped event
      // (including an earlier line of this same committed batch) may have changed a spec, so
      // carrying approval forward is safe only from the flow's immediately preceding snapshot.
      // Normalize both sides: older rows and publication events can still contain path aliases.
      const publishedPaths = new Set(event.paths.map((path) => posix.normalize(path)));
      const reask = flow.state === 'PENDING' || event.previousSha !== flow.specSha ||
        flow.features.some(({ specPath }) => publishedPaths.has(posix.normalize(specPath)));
      if (reask) {
        if (!canTransitionFlow(flow.state, 'PENDING')) return;
        await this.reaskLocked(flow, event.sha, new Date());
      } else {
        await this.recordRespec(await this.flows.updateSha(flow.id, event.sha));
      }
    });
  }

  /** Caller holds parent then flow locks. Reapproval starts no more work; it never cancels a job. */
  async reaskLocked(flow: FleetFlowRecord, specSha: string, now: Date): Promise<FleetFlowRecord> {
    // close uses SKIP LOCKED. Even when a decision holds the old ask, the new request id
    // and sha on the flow make that late decision a no-op after our transaction commits.
    if (flow.approvalRequestId !== null) {
      await this.asks.close(flow.approvalRequestId, { status: 'cancelled', reason: 'superseded' }, now);
    }
    const approvalRequestId = await this.openStartRequest({ ...flow, specSha }, {
      type: flow.createdByType, id: flow.createdById,
    }, now);
    const changed = await this.flows.reask(flow.id, { specSha, approvalRequestId });
    await this.recordRespec(changed);
    return changed;
  }

  private async recordRespec(flow: FleetFlowRecord): Promise<void> {
    await this.audit.record({
      key: 'system.flow.respec', resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId,
      summary: 'flow spec republished',
    });
    await this.activity.record({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.respec', entityType: 'flow',
      entityId: flow.id, projectId: flow.projectId, payload: { flowId: flow.id, state: flow.state },
    });
  }

  async create(input: CreateFlowInput, creator: FlowCreator, context: CreateFlowContext): Promise<CreatedFlow> {
    const now = context.now ?? new Date();
    return this.txManager.run(async () => {
      const target = input.entry === 'THREAD'
        ? await this.lockThreadEntry(input, creator, context.projectId)
        : await this.lockNaxEntry(input, context.projectId);

      const created = await this.flows.create({
        projectId: target.projectId,
        repoId: target.repoId,
        threadId: target.threadId,
        entry: input.entry,
        createdByType: creator.type,
        createdById: creator.id,
        branch: target.branch,
        specSha: target.specSha,
        pinnedRunnerId: target.pinnedRunnerId,
        reviewerRole: input.roles.reviewer,
        supervisorRole: input.roles.supervisor,
        costCapUsd: input.costCapUsd,
        approvalMode: null,
        features: input.features,
      });

      // The flow is either started by the tick it consumed or left waiting on the start ask; the ask
      // and the tick both commit with the insert.
      const flow = target.tick === null
        ? await this.askStart(created, creator, now)
        : await this.consumeTick(created, target.tick.userId, now);

      await this.audit.record({
        key: 'fleet.flow.create', resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId,
        summary: `${flow.entry} flow create`,
      });
      await this.activity.record({
        actorType: creator.type, actorId: creator.id, action: 'flow.created', entityType: 'flow',
        entityId: flow.id, projectId: flow.projectId,
        payload: { flowId: flow.id, entry: flow.entry, featureCount: flow.features.length, state: flow.state },
      });

      return { flow, approvalRequestId: flow.approvalRequestId };
    });
  }

  /**
   * Opens the `fleet.flow.start` ask on the creator's behalf and stores the pending request on the
   * flow. `fleet.flow.start` is `critical`, so its floor is `human` and no policy can lower it: an ask
   * that resolved to `none` would be a catalog regression, not a case to handle.
   */
  private async askStart(flow: FleetFlowRecord, creator: FlowCreator, now: Date): Promise<FleetFlowRecord> {
    return this.flows.setApprovalRequestId(flow.id, await this.openStartRequest(flow, creator, now));
  }

  private async openStartRequest(flow: FleetFlowRecord, creator: FlowCreator, now: Date): Promise<string> {
    const outcome = await this.asks.open({
      key: 'fleet.flow.start',
      projectId: flow.projectId,
      component: 'flow',
      onBehalfOf: { type: creator.type, id: creator.id },
      origin: 'system',
      input: { flowId: flow.id, specSha: flow.specSha },
      deadline: null,
    }, now);
    if (outcome.status === 'not-needed') throw new Error('fleet.flow.start resolved to no approval');
    return outcome.request.id;
  }

  /** Spends the thread's tick and starts the flow APPROVED; the tick is gone for the next flow. */
  private async consumeTick(flow: FleetFlowRecord, tickUserId: string, now: Date): Promise<FleetFlowRecord> {
    if (flow.threadId === null) throw new Error('a tick only covers a thread flow');
    await this.threads.consumePreApproval(flow.threadId);
    return this.flows.approve(flow.id, {
      mode: 'PRE_APPROVED', approverId: tickUserId, approvedAt: now, approvalRequestId: null,
    });
  }

  /**
   * The thread entry: the thread row lock, then the thread-entry guards (`ThreadsService.lockForFlow`
   * owns `threadsEnabled` and throws them in the Failure Handling order), then one live flow per thread.
   * Branch, sha and runner come from the locked record — a thread publish never pushes, so the forge
   * cannot answer for them — and the flow pins that publish record as it is now.
   */
  private async lockThreadEntry(input: CreateFlowInput, creator: FlowCreator, projectId: string): Promise<FlowTarget> {
    if (!input.threadId) throw new ValidationAppException({ reason: 'threadId' }, 'fleet.flowInput');
    const thread = await this.threads.lockForFlow(projectId, input.threadId);
    if (thread.publishedSha === null) throw new ConflictAppException({}, 'threads.notPublished');
    const live = await this.flows.findLiveForThread(thread.id);
    if (live) throw new ConflictAppException({ flowId: live.id }, 'fleet.flows.threadBusy');
    // `lockForFlow` already refused a PROJECT or WORKSPACE thread; this only widens the fields to non-null.
    const { repoId, feature } = repoThreadFields(thread);

    return {
      projectId: thread.projectId,
      repoId,
      threadId: thread.id,
      branch: `feat/${feature}`,
      specSha: thread.publishedSha,
      pinnedRunnerId: thread.runnerId,
      tick: coversFlow(thread.preApproval, thread, creator, input.costCapUsd) ? thread.preApproval : null,
    };
  }

  /**
   * The nax entry: the `FleetRepo` row lock serialises creation, so two concurrent calls cannot both
   * pass the live-duplicate check on `(repoId, branch, specSha)`. A repo in another project is the
   * route's 404 — the caller reached a repo it cannot use.
   */
  private async lockNaxEntry(input: CreateFlowInput, projectId: string): Promise<FlowTarget> {
    if (!input.repoId) throw new ValidationAppException({ reason: 'repoId' }, 'fleet.flowInput');
    if (input.branch === undefined || !GIT_REF_RE.test(input.branch)) throw new ValidationAppException({ reason: 'branch' }, 'fleet.flowInput');
    if (input.specSha === undefined || !SPEC_SHA_RE.test(input.specSha)) throw new ValidationAppException({ reason: 'specSha' }, 'fleet.flowInput');
    const repo = await this.repos.lockById(input.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.flows.repoNotFound');
    const live = await this.flows.findLiveForSpec(repo.id, input.branch, input.specSha);
    if (live) throw new ConflictAppException({ flowId: live.id }, 'fleet.flows.duplicate');

    return {
      projectId: repo.projectId,
      repoId: repo.id,
      threadId: null,
      branch: input.branch,
      specSha: input.specSha,
      pinnedRunnerId: null,
      tick: null,
    };
  }
}

/**
 * Whether a thread's tick starts this flow. A tick covers the thread's creator's own flow, and it
 * covers a flow whose creator the tick's user is; only a `USER` can be either, so an agent's flow is
 * always PENDING. The tick's cap must be at least the flow's cap, compared as decimals — never floats.
 */
function coversFlow(
  tick: { userId: string; costCapUsd: string } | null,
  thread: { createdById: string; createdByType?: 'USER' | 'AGENT' },
  creator: FlowCreator,
  costCapUsd: string,
): tick is { userId: string; costCapUsd: string } {
  if (tick === null) return false;
  const isTickUser = creator.type === 'USER' && creator.id === tick.userId;
  const isThreadCreator = creator.id === thread.createdById && creator.type === (thread.createdByType ?? 'USER');
  if (!isTickUser && !isThreadCreator) return false;
  return new Prisma.Decimal(tick.costCapUsd).greaterThanOrEqualTo(new Prisma.Decimal(costCapUsd));
}
