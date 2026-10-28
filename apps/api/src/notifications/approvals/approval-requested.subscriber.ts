import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ASK_KEYS_BY_COMPONENT } from '../../approvals/approval-ask.service';
import { decideEligibility } from '../../approvals/approval-eligibility';
import { APPROVAL_REQUEST_CHANGED, parseApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { PermissionService } from '../../permissions/permission.service';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { NotificationEligibility } from '../notification-eligibility';
import { NotificationWriter } from '../notification-writer';
import { approvalRequestDrafts } from './approval-request-drafts';

@Injectable()
@SystemWriter('system.notification.fleet')
export class ApprovalRequestedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ApprovalRequestedSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly queries: ApprovalRequestQueries,
    private readonly permissions: PermissionService,
    private readonly eligibility: NotificationEligibility,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_REQUEST_CHANGED, this.handle);
  }

  /** Keep the relay's action context and let database failures trigger its retry. */
  private readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseApprovalRequestChangedPayload(payload);
    if (!p) {
      this.logger.warn(`${APPROVAL_REQUEST_CHANGED}: malformed payload skipped`);
      return;
    }
    // The two fleet asks are notified by the fleet's own subscriber (`fleet_approval_requested`,
    // every global admin) until P3 web ships the `/approvals` page this one's link points at.
    if (Object.values(ASK_KEYS_BY_COMPONENT).includes(p.permissionKey)) return;
    if (p.status !== 'pending') return;
    const request = await this.queries.findById(p.requestId);
    if (!request || request.status !== 'pending') return;
    const projectId = request.projectId;
    const candidates = projectId === null
      ? await this.eligibility.findGlobalAdminIds()
      : await this.permissions.principalIdsWithKey('USER', projectId, 'approval.decide');
    const eligible = await Promise.all(candidates.map(async (id) => {
      const principal = { type: 'USER' as const, id };
      const keys = await this.permissions.effectiveKeys(principal, projectId === null ? 'global' : { projectId });
      return decideEligibility(request, principal, keys).ok ? id : null;
    }));
    const kept = eligible.filter((id): id is string => id !== null);
    if (kept.length === 0) return;
    await this.writer.deliver(approvalRequestDrafts(kept, {
      requestId: request.id, projectId, permissionKey: request.permissionKey,
    }));
  };
}
