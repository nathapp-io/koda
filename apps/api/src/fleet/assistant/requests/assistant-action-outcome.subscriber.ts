import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../../../approvals/approval-request-events';
import { ApprovalRequestQueries } from '../../../approvals/approval-request.queries';
import { ThreadEventBus } from '../../../live/thread-event-bus';
import { FanOutPublisher } from '../../../outbox/fan-out-publisher';
import { SystemWriter } from '../../../permissions/system-writer.decorator';
import { ASSISTANT_ACTION_REQUEST_REPOSITORY, type AssistantActionRequestRepository } from './assistant-action-request.domain';
import { requestOutcomeNote } from './request-outcome-note';

@Injectable()
@SystemWriter('system.thread.ingest')
export class AssistantActionOutcomeSubscriber implements OnModuleInit {
  private readonly logger = new Logger(AssistantActionOutcomeSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    @Inject(ASSISTANT_ACTION_REQUEST_REPOSITORY) private readonly links: AssistantActionRequestRepository,
    private readonly queries: ApprovalRequestQueries,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly bus: ThreadEventBus,
  ) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_REQUEST_CHANGED, this.handle);
  }

  /** Keep the relay's outbox system context; database errors must reach its retry loop. */
  private readonly handle = async (payload: unknown): Promise<void> => {
    const event = parseApprovalRequestChangedPayload(payload);
    if (!event) {
      this.logger.warn(`${APPROVAL_REQUEST_CHANGED}: malformed payload skipped`);
      return;
    }
    if (!['executed', 'failed', 'rejected', 'expired', 'cancelled'].includes(event.status)) return;
    const link = await this.links.findByRequest(event.requestId);
    if (!link?.threadId) return;
    const threadId = link.threadId;
    const messageId = await this.txManager.run(async () => {
      // Match the transcript writer lock order, and tolerate deletion before the lock is taken.
      if (!(await this.links.lockThread(threadId))) return null;
      const locked = await this.links.lockByRequest(event.requestId);
      if (!locked || locked.notedAt !== null) return null;
      const request = await this.queries.findById(event.requestId);
      if (!request) throw new Error(`Linked approval request ${event.requestId} is missing`);
      const content = requestOutcomeNote({ requestId: request.id, tool: locked.tool, status: request.status, result: request.result });
      const id = await this.links.insertSystemNote(threadId, content);
      await this.links.markNoted(event.requestId, id, new Date());
      return id;
    });
    if (messageId === null) return;
    const at = new Date().toISOString();
    this.bus.publish({ id: randomUUID(), type: 'message', threadId, messageId, at });
    this.bus.publish({ id: randomUUID(), type: 'thread', threadId, at });
  };
}
