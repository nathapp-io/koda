import { SystemWriter } from '../../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { randomUUID } from 'crypto';
import { FLEET_CFG, IFleetConfig } from '../../../config/fleet.config';
import { ThreadEventBus } from '../../../live/thread-event-bus';
import { ApprovalLivePublisher } from '../../approvals/approval-live.publisher';
import { APPROVAL_REPOSITORY, IApprovalRepository } from '../../approvals/domain/approval.domain';
import { AssistantActionDecisions, type SettledAction } from './assistant-action-decisions';
import { PENDING_ACTION_REPOSITORY, PendingActionRecord, PendingActionRepository } from './pending-action.domain';

/** 2a-D10: at most this many actions expire in one tick; a longer backlog waits for the next one. */
export const MAX_PER_TICK = 100;

export interface PendingActionExpiryResult { expired: number; failed: number }

/**
 * S5b 2a (2a-D10): expires the `assistant_action`s their requester never decided, on the same interval as the bash
 * sweeper (`fleetConfig.approvalSweepMs`, gated by `fleetConfig.sweepEnabled`).
 *
 * It owns no expiry logic of its own: each action runs in its own transaction through
 * `AssistantActionDecisions.expireLocked`, which is also what the decide handler calls when a decide arrives past
 * `expiresAt` — so the two closers of an action cannot drift.
 */
@Injectable()
@SystemWriter('system.assistant-action.expire')
export class PendingActionExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingActionExpirySweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly tx: ITransactionManager,
    @Inject(PENDING_ACTION_REPOSITORY) private readonly actions: Pick<PendingActionRepository, 'findDue' | 'lockThread' | 'lockById'>,
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: Pick<IApprovalRepository, 'lockById'>,
    private readonly decisions: AssistantActionDecisions,
    private readonly live: ApprovalLivePublisher,
    private readonly threads: ThreadEventBus,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'sweepEnabled' | 'approvalSweepMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Action expiry sweep failed: ${reason(error)}`));
    }, this.cfg.approvalSweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One transaction and one lock scope per action: one failing Action never costs the rest of the batch (2a-D10). */
  async tick(now = new Date()): Promise<PendingActionExpiryResult> {
    const result: PendingActionExpiryResult = { expired: 0, failed: 0 };
    for (const due of await this.actions.findDue(now, MAX_PER_TICK)) {
      try {
        const settled = await this.tx.run(() => this.expireOne(due, now));
        if (!settled) continue;
        this.live.publish(settled.live);
        this.publishNote(due.threadId, settled.noteId, now);
        result.expired += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Action ${due.id} not expired: ${reason(error)}`);
      }
    }
    return result;
  }

  /**
   * 2a-D10 steps 1-5 and 2a-D11's lock order (thread, then approval, then action), inside the caller's transaction.
   * The re-check is what makes a decide that won the race harmless: it moved the action and its approval out of
   * `PENDING`/`pending`, so this tick leaves the row alone. Null means "nothing to do", never a failure.
   */
  private async expireOne(due: PendingActionRecord, now: Date): Promise<SettledAction | null> {
    if (!(await this.actions.lockThread(due.threadId))) return null;
    const approval = due.approvalId === null ? null : await this.approvals.lockById(due.approvalId);
    const action = await this.actions.lockById(due.id);
    if (!action || !approval || approval.status !== 'pending' || action.status !== 'PENDING' || action.expiresAt.getTime() > now.getTime()) return null;
    return this.decisions.expireLocked(action, approval, now);
  }

  /** After the commit: the note's own message frame, then the thread that now carries it. */
  private publishNote(threadId: string, noteId: string, now: Date): void {
    const at = now.toISOString();
    this.threads.publish({ id: randomUUID(), threadId, at, type: 'message', messageId: noteId });
    this.threads.publish({ id: randomUUID(), threadId, at, type: 'thread' });
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
