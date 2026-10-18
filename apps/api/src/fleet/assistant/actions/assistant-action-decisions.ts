import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { randomUUID } from 'crypto';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../../config/fleet.config';
import type { LiveFleetApprovalEvent } from '../../../live/live-event';
import { ThreadEventBus } from '../../../live/thread-event-bus';
import { ApprovalCloser, type ApprovalActor, userActor } from '../../approvals/approval-closer';
import { ApprovalLivePublisher } from '../../approvals/approval-live.publisher';
import { AssistantActionPort, type AssistantActionDecider } from '../../approvals/assistant-action.port';
import type { ApprovalCaller } from '../../approvals/approvals.service';
import { APPROVAL_REPOSITORY, FleetApprovalRecord, IApprovalRepository } from '../../approvals/domain/approval.domain';
import type { DecideApprovalDto } from '../../approvals/dto/decide-approval.dto';
import { SYSTEM_ACTOR } from '../../common/system-actor';
import { capText } from '../assistant-tool-safety';
import { AssistantToolExecutor, RESULT_CAP_BYTES, type ActionOutcome } from '../assistant-tool.executor';
import { outcomeNote } from './outcome-note';
import { PENDING_ACTION_REPOSITORY, PendingActionRecord, PendingActionRepository } from './pending-action.domain';

/** What one locked write settled: the closed approval, its live frames and the id of the note it wrote. */
export interface SettledAction {
  approval: FleetApprovalRecord;
  live: LiveFleetApprovalEvent[];
  noteId: string;
}

/** 2a-D8 step 8: the decide commit that approves an action, before its tool has run. */
export interface ApprovedAction {
  approval: FleetApprovalRecord;
  live: LiveFleetApprovalEvent[];
  action: PendingActionRecord;
}

type Decided =
  | ({ kind: 'approved' } & ApprovedAction)
  | ({ kind: 'rejected' | 'expired' } & SettledAction)
  | { kind: 'not_pending' };

const notPending = (): ConflictAppException => new ConflictAppException({}, 'fleet.approvalNotPending');

/**
 * S5b 2a (2a-D8): the creator-only decide handler of an `assistant_action` approval. `ApprovalsService` reaches it
 * through `AssistantActionPort`, which this class registers with on init (2a-D1), so `ApprovalsModule` never imports
 * the assistant module. Every transaction takes the thread, then the approval, then the action lock (2a-D11), and
 * every live event is published only after that transaction commits.
 */
@Injectable()
export class AssistantActionDecisions implements OnModuleInit, AssistantActionDecider {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly tx: ITransactionManager,
    @Inject(PENDING_ACTION_REPOSITORY) private readonly actions: PendingActionRepository,
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: IApprovalRepository,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    private readonly threads: ThreadEventBus,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'threadsEnabled'>,
    private readonly port: AssistantActionPort,
    private readonly executor: AssistantToolExecutor,
  ) {}

  onModuleInit(): void {
    this.port.register(this);
  }

  async decide(caller: ApprovalCaller, current: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalRecord> {
    const stored = await this.actions.findById(String(current.payload['actionId'] ?? ''));
    if (!stored) throw notPending();
    // 2a-R2: the project role and the global ADMIN do not matter, only who asked.
    if (caller.id !== current.payload['requestedById']) throw new ForbiddenAppException({}, 'threads.notCreator');
    if (dto.decision !== 'approve' && dto.decision !== 'reject') {
      throw new ValidationAppException({ reason: `${dto.decision} does not apply to an assistant action` }, 'fleet.approvalDecisionInvalid');
    }
    if (!this.cfg.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    // 2a-D8 step 5: an approve re-authorizes the requester before the locked status checks, so a requester who lost
    // membership, the ability or their account is refused even for an action that is no longer pending. Nothing is
    // written: the action keeps whatever status it had.
    if (dto.decision === 'approve' && (await this.executor.checkAction(stored)) === 'forbidden') {
      throw new ForbiddenAppException({}, 'projects');
    }

    const result = await this.tx.run((): Promise<Decided> => this.settle(caller, stored, current.id, dto, now));
    // The expiry above has committed; only now refuse the decide.
    if (result.kind === 'not_pending') throw notPending();
    if (result.kind !== 'approved') {
      this.publish(stored.threadId, result, now);
      if (result.kind === 'expired') throw notPending();
      return result.approval;
    }
    // 2a-D8 step 8: the approval and the APPROVED action have committed, so the tool runs outside that transaction
    // and its outcome is written by a second one. The approval stays approved whatever the tool does.
    this.live.publish(result.live);
    const outcome = await this.executor.executeAction(result.action);
    const noteId = await this.finalize(result.action, outcome, now);
    if (noteId !== null) this.publishNote(result.action.threadId, noteId, now);
    return result.approval;
  }

  /**
   * 2a-D10 steps 3-5. The caller holds the thread, approval and action locks. The action is read back from the
   * write so the note names the status it was given, not the one the caller saw.
   */
  async expireLocked(action: PendingActionRecord, approval: FleetApprovalRecord, now: Date): Promise<SettledAction> {
    const expiredAction = await this.actions.resolve(action.id, { status: 'EXPIRED', decidedAt: now });
    const expired = await this.approvals.resolve(approval.id, { status: 'expired', resolvedBy: 'timeout', decidedAt: now });
    const actor: ApprovalActor = { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: action.actorId };
    const live = await this.closer.recordResolved(expired, actor);
    return { approval: expired, live, noteId: await this.actions.insertSystemNote(action.threadId, outcomeNote(expiredAction)) };
  }

  /** 2a-D8 steps 6-7 in the caller's transaction. */
  private async settle(caller: ApprovalCaller, stored: PendingActionRecord, approvalId: string, dto: DecideApprovalDto, now: Date): Promise<Decided> {
    if (!(await this.actions.lockThread(stored.threadId))) return { kind: 'not_pending' };
    const approval = await this.approvals.lockById(approvalId);
    const action = await this.actions.lockById(stored.id);
    if (!approval || !action || approval.status !== 'pending' || action.status !== 'PENDING') return { kind: 'not_pending' };
    if (action.expiresAt.getTime() <= now.getTime()) return { kind: 'expired', ...(await this.expireLocked(action, approval, now)) };
    if (dto.decision === 'approve') return { kind: 'approved', ...(await this.approve(caller, action, approval, dto, now)) };
    return { kind: 'rejected', ...(await this.reject(caller, action, approval, dto, now)) };
  }

  /**
   * 2a-D8 step 8, first half: the approval closes and the action becomes APPROVED in the caller's transaction, so the
   * decision is durable before the tool is allowed to write anything. The action is read back from the write, so what
   * runs afterwards is the row as stored.
   */
  private async approve(caller: ApprovalCaller, action: PendingActionRecord, approval: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<ApprovedAction> {
    const decided = await this.approvals.resolve(approval.id, {
      status: 'approved', resolvedBy: 'user', decidedAt: now, decision: 'approve', decidedById: caller.id, comment: dto.comment ?? null,
    });
    const approved = await this.actions.resolve(action.id, { status: 'APPROVED', approverId: caller.id, decidedAt: now });
    return { approval: decided, live: await this.closer.recordResolved(decided, userActor(caller.id)), action: approved };
  }

  /**
   * 2a-D8 step 8, second half: a transaction of its own — the tool has already run, so this settles its outcome. It
   * takes the thread lock first (2a-D11), then the action, and writes the terminal status and the note together. A
   * thread that is gone leaves nothing to write, and the decide route still answers 200 with the approved approval.
   */
  private finalize(action: PendingActionRecord, outcome: ActionOutcome, now: Date): Promise<string | null> {
    return this.tx.run(async () => {
      if (!(await this.actions.lockThread(action.threadId))) return null;
      if (!(await this.actions.lockById(action.id))) return null;
      const settled = await this.actions.resolve(action.id, {
        status: outcome.ok ? 'EXECUTED' : 'FAILED',
        // The column's own invariant: whatever answered the outcome, `result` never exceeds `RESULT_CAP_BYTES`.
        // `executeAction` already caps, so this is a clamp on text that fits, not a second truncation.
        result: capText(outcome.text, RESULT_CAP_BYTES),
        approverId: action.approverId ?? undefined,
        decidedAt: now,
      });
      return this.actions.insertSystemNote(settled.threadId, outcomeNote(settled));
    });
  }

  private async reject(caller: ApprovalCaller, action: PendingActionRecord, approval: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<SettledAction> {
    const decided = await this.approvals.resolve(approval.id, {
      status: 'rejected', resolvedBy: 'user', decidedAt: now, decision: 'reject', decidedById: caller.id, comment: dto.comment ?? null,
    });
    const rejected = await this.actions.resolve(action.id, { status: 'REJECTED', approverId: caller.id, decidedAt: now });
    const live = await this.closer.recordResolved(decided, userActor(caller.id));
    return { approval: decided, live, noteId: await this.actions.insertSystemNote(action.threadId, outcomeNote(rejected)) };
  }

  /** After the commit: the approval's live frames, then the thread's new note and the changed thread. */
  private publish(threadId: string, settled: SettledAction, now: Date): void {
    this.live.publish(settled.live);
    this.publishNote(threadId, settled.noteId, now);
  }

  /** After the finalization commit: the note's own message frame, then the thread that now carries it. */
  private publishNote(threadId: string, noteId: string, now: Date): void {
    const at = now.toISOString();
    this.threads.publish({ id: randomUUID(), threadId, at, type: 'message', messageId: noteId });
    this.threads.publish({ id: randomUUID(), threadId, at, type: 'thread' });
  }
}
