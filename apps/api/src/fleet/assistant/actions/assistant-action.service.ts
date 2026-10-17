import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { randomUUID } from 'crypto';
import type { LiveFleetApprovalEvent } from '../../../live/live-event';
import { ThreadEventBus } from '../../../live/thread-event-bus';
import { ApprovalLivePublisher } from '../../approvals/approval-live.publisher';
import { ApprovalCloser } from '../../approvals/approval-closer';
import {
  ACTION_TTL_MS, MAX_PENDING_ACTIONS, PENDING_ACTION_REPOSITORY, ActionProposer, PendingActionRepository,
  ProposeInput, ProposeResult, assistantThreadPath,
} from './pending-action.domain';

/** What one transaction of `propose` decided: a fresh action, an existing one, or the per-thread cap. */
type Proposal =
  | { kind: 'created'; actionId: string; live: LiveFleetApprovalEvent[] }
  | { kind: 'existing'; actionId: string }
  | { kind: 'refused' };

/**
 * S5b 2a (2a-D4): the propose side of a koda write-tool call. It owns the whole transaction — thread lock, duplicate
 * read, cap, insert, approval — and publishes both buses only after that transaction commits. The executor reaches it
 * through `ActionProposer` (US-002 attaches it at init), so this service never depends on the executor.
 */
@Injectable()
export class AssistantActionService implements ActionProposer {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly tx: ITransactionManager,
    @Inject(PENDING_ACTION_REPOSITORY) private readonly actions: PendingActionRepository,
    private readonly approvals: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    private readonly threads: ThreadEventBus,
  ) {}

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const proposal = await this.tx.run(() => this.open(input));
    if (proposal.kind === 'refused') return { refused: true };
    if (proposal.kind === 'existing') return { actionId: proposal.actionId };
    this.live.publish(proposal.live);
    // The thread's readers re-render on this: a new action card and its inbox row exist now.
    this.threads.publish({ id: randomUUID(), threadId: input.threadId, at: input.now.toISOString(), type: 'thread' });
    return { actionId: proposal.actionId };
  }

  /**
   * 2a-D4, in one transaction. Step 1 takes the thread row lock, which serialises every write call of the thread, so
   * the duplicate read of step 2 and the count of step 3 are decided against committed state: a repeat call of a job
   * answers its stored action, and two calls racing for the last of the 10 slots cannot both win one.
   */
  private async open(input: ProposeInput): Promise<Proposal> {
    if (!(await this.actions.lockThread(input.threadId))) throw new NotFoundAppException({}, 'threads');
    const existing = await this.actions.findByCall(input.jobId, input.toolCallId);
    if (existing) return { kind: 'existing', actionId: existing.id };
    if ((await this.actions.countPending(input.threadId)) >= MAX_PENDING_ACTIONS) return { kind: 'refused' };
    const action = await this.actions.insert({
      projectId: input.projectId, threadId: input.threadId, jobId: input.jobId, toolCallId: input.toolCallId,
      tool: input.tool, input: input.input, preview: input.preview, requestedById: input.requestedById,
      expiresAt: new Date(input.now.getTime() + ACTION_TTL_MS),
    });
    const path = assistantThreadPath(input.threadId, input.threadKind, input.threadProjectSlug);
    const { approval, live } = await this.approvals.openAssistant(action, path, input.now);
    await this.actions.setApprovalId(action.id, approval.id);
    return { kind: 'created', actionId: action.id, live };
  }
}
