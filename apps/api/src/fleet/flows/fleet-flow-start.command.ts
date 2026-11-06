import { Inject, Injectable } from '@nestjs/common';
import { currentContext } from '../../action-context/action-context';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import type { ApprovalCommand } from '../../approvals/approval-command.registry';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FleetActorType } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FLEET_FLOW_REPOSITORY, type IFleetFlowRepository } from './domain/fleet-flow.domain';

export interface FlowStartInput { flowId: string; specSha: string }
export interface FlowStartResult { applied: boolean }

@Injectable()
export class FleetFlowStartCommand implements ApprovalCommand<FlowStartInput, FlowStartResult> {
  readonly key = 'fleet.flow.start';

  constructor(
    @Inject(FLEET_FLOW_REPOSITORY) private readonly flows: Pick<IFleetFlowRepository, 'lockById' | 'findById' | 'approve' | 'stop'>,
    private readonly audit: AuditRecorder,
    private readonly activity: FleetActivityService,
  ) {}

  parse(input: unknown): FlowStartInput {
    if (!isRecord(input) || typeof input.flowId !== 'string' || input.flowId.length === 0 ||
      typeof input.specSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.specSha)) {
      throw new Error('invalid fleet flow start input');
    }
    return { flowId: input.flowId, specSha: input.specSha };
  }

  async details(request: ApprovalRequestRecord): Promise<Record<string, unknown> | null> {
    const input = this.parse(request.input);
    const flow = await this.flows.findById(input.flowId);
    if (!flow) return null;
    return {
      kind: 'flow', flowId: flow.id, state: flow.state, branch: flow.branch, specSha: flow.specSha,
      costCapUsd: flow.costCapUsd, features: flow.features,
    };
  }

  async execute(input: FlowStartInput): Promise<FlowStartResult> {
    const { requestId, approverId } = approvalFromContext();
    const flow = await this.currentPending(input, requestId);
    if (!flow) return { applied: false };
    await this.flows.approve(flow.id, {
      mode: 'REQUEST', approverId, approvedAt: new Date(), approvalRequestId: requestId,
    });
    await this.audit.record({
      key: this.key, resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId, summary: 'flow approved',
    });
    await this.activity.record({
      actorType: FleetActorType.USER, actorId: approverId, action: 'flow.approved', entityType: 'flow',
      entityId: flow.id, projectId: flow.projectId, payload: { flowId: flow.id, state: 'APPROVED' },
    });
    return { applied: true };
  }

  async onReject(input: FlowStartInput): Promise<void> {
    const requestId = currentContext()?.approval.requestId;
    if (!requestId) return;
    const flow = await this.currentPending(input, requestId);
    if (!flow) return;
    await this.flows.stop(flow.id, 'approval_rejected', new Date());
    await this.audit.record({
      key: this.key, resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId, summary: 'flow rejected',
    });
    await this.activity.record({
      actorType: FleetActorType.USER, actorId: currentContext()?.actor.id ?? 'unknown', action: 'flow.stopped',
      entityType: 'flow', entityId: flow.id, projectId: flow.projectId,
      payload: { flowId: flow.id, state: 'STOPPED', stopReason: 'approval_rejected' },
    });
  }

  private async currentPending(input: FlowStartInput, requestId: string) {
    const flow = await this.flows.lockById(input.flowId);
    if (!flow || flow.state !== 'PENDING' || flow.approvalRequestId !== requestId || flow.specSha !== input.specSha) return null;
    return flow;
  }
}

function approvalFromContext(): { requestId: string; approverId: string } {
  const approval = currentContext()?.approval;
  if (!approval?.requestId || !approval.approverId) throw new Error('fleet flow approval requires request and approver ids');
  return { requestId: approval.requestId, approverId: approval.approverId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
