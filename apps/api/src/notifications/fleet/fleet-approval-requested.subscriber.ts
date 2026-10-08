import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BudgetScopeLabels } from '../../fleet/budgets/budget-scope-labels';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { approvalDrafts } from './fleet-notification-drafts';
import { FLEET_APPROVAL_REQUESTED, parseApprovalRequestedPayload } from './fleet-notification-events';
import { FleetNotificationReader } from './fleet-notification.reader';

const KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  nax_bash_escalate: 'bash',
  budget_override_required: 'budget override',
});

/**
 * Fleet S4a §2.4 (D505, D514): fleet_approval_requested (enqueued since #236) -> every global admin.
 * Registering this handler releases the rows PrismaOutboxStore held back, so an ask that is no longer
 * pending when it is handled creates nothing.
 */
@Injectable()
export class FleetApprovalRequestedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetApprovalRequestedSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly reader: FleetNotificationReader,
    private readonly eligibility: NotificationEligibility,
    private readonly labels: BudgetScopeLabels,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_APPROVAL_REQUESTED, this.handle);
  }

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseApprovalRequestedPayload(payload);
    if (!p) {
      this.logger.warn(`${FLEET_APPROVAL_REQUESTED}: malformed payload skipped`);
      return;
    }
    const ctx = await this.reader.approvalContext(p.approvalId);
    if (!ctx || ctx.status !== 'pending') return;
    const repo = ctx.repo ?? (p.policyId ? await this.labels.forPolicy(p.policyId) : null) ?? 'fleet';
    const adminIds = await this.eligibility.findGlobalAdminIds();
    await this.writer.deliver(approvalDrafts(adminIds, {
      approvalId: p.approvalId, projectId: p.projectId, kindLabel: KIND_LABEL[p.type] ?? p.type, repo,
    }));
  };
}
