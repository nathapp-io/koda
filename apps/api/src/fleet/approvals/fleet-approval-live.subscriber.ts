import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { parseApprovalRequestChangedPayload, APPROVAL_REQUEST_CHANGED } from '../../approvals/approval-request-events';
import { ProjectEventBus } from '../../live/project-event-bus';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { FLEET_ASK_KEYS } from './domain/approval.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/** The fleet writes pending/cancelled itself; engine approved is followed by executed/failed. */
const LIVE_STATUSES = new Set(['rejected', 'executed', 'failed', 'expired']);

/**
 * Durable live delivery, independent of activity/webhook recording. The link lock serialises redeliveries; its
 * publication marker is written only after publication succeeds. Failures propagate to the relay. The bus deduplicates
 * successful consumers during partial fan-out / marker-commit retries; a process restart also closes its SSE streams.
 */
@Injectable()
export class FleetApprovalLiveSubscriber implements OnModuleInit {
  constructor(
    private readonly registry: FanOutPublisher,
    private readonly bus: ProjectEventBus,
    private readonly store: FleetApprovalAskStore,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_REQUEST_CHANGED, this.handle);
  }

  private readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseApprovalRequestChangedPayload(payload);
    if (!p || p.projectId === null || !FLEET_ASK_KEYS.includes(p.permissionKey) || !LIVE_STATUSES.has(p.status)) return;

    await this.txManager.run(async () => {
      const link = await this.store.lockByRequest(p.requestId);
      if (link === null || link.publishedStatus === p.status) return;
      const view = await this.store.findApproval(p.requestId);
      if (view === null || view.projectId === null) return;
      this.bus.publishRetryable({
        id: `${p.requestId}:${p.status}:fleet`,
        type: 'fleet_approval',
        projectId: view.projectId,
        approvalId: view.id,
        status: view.status,
        at: new Date().toISOString(),
      });
      await this.store.setPublishedStatus(p.requestId, p.status);
    });
  };
}
