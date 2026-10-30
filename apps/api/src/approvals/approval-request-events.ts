import { Injectable } from '@nestjs/common';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { WebhookDispatcherService } from '../webhook/webhook-dispatcher.service';
import type { ApprovalMode } from '../permissions/catalog';
import type { ApprovalRequestRecord, ApprovalRequestStatus } from './domain/approval.domain';

export const APPROVAL_REQUEST_CHANGED = 'approval_request_changed';

/** The outbox payload. Never the frozen input or the result (they may carry user content). */
export interface ApprovalRequestChangedPayload {
  requestId: string;
  status: ApprovalRequestStatus;
  projectId: string | null;
  permissionKey: string;
  requiredMode: ApprovalMode;
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  actorId: string;
  onBehalfOfType: 'USER' | 'AGENT' | null;
  onBehalfOfId: string | null;
  expiresAt: string;
}

/** Null when the input is not an object or a required identifying string is empty or absent. */
export function parseApprovalRequestChangedPayload(raw: unknown): ApprovalRequestChangedPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  for (const field of ['requestId', 'status', 'permissionKey', 'actorId'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) return null;
  }
  return {
    requestId: value.requestId as string,
    status: value.status as ApprovalRequestStatus,
    projectId: value.projectId as string | null,
    permissionKey: value.permissionKey as string,
    requiredMode: value.requiredMode as ApprovalMode,
    actorType: value.actorType as ApprovalRequestChangedPayload['actorType'],
    actorId: value.actorId as string,
    onBehalfOfType: value.onBehalfOfType as ApprovalRequestChangedPayload['onBehalfOfType'],
    onBehalfOfId: value.onBehalfOfId as string | null,
    expiresAt: value.expiresAt as string,
  };
}

export interface ApprovalWebhookPayload extends ApprovalRequestChangedPayload {
  path: string;
}

/** Explicit allowlist: frozen input, results and decisions never leave through webhooks. */
export function approvalWebhookPayloadOf(request: ApprovalRequestRecord): ApprovalWebhookPayload {
  return {
    requestId: request.id,
    permissionKey: request.permissionKey,
    status: request.status,
    projectId: request.projectId,
    requiredMode: request.requiredMode,
    actorType: request.actor.type,
    actorId: request.actor.id,
    onBehalfOfType: request.onBehalfOf?.type ?? null,
    onBehalfOfId: request.onBehalfOf?.id ?? null,
    expiresAt: request.expiresAt.toISOString(),
    path: `/approvals?id=${request.id}`,
  };
}

@Injectable()
export class ApprovalRequestEvents {
  constructor(
    private readonly outbox: OutboxService,
    private readonly webhooks: WebhookDispatcherService,
  ) {}

  /** Records an approval request change in the transaction that wrote its status. */
  async record(request: ApprovalRequestRecord): Promise<void> {
    const payload: ApprovalRequestChangedPayload = {
      requestId: request.id,
      status: request.status,
      projectId: request.projectId,
      permissionKey: request.permissionKey,
      requiredMode: request.requiredMode,
      actorType: request.actor.type,
      actorId: request.actor.id,
      onBehalfOfType: request.onBehalfOf?.type ?? null,
      onBehalfOfId: request.onBehalfOf?.id ?? null,
      expiresAt: request.expiresAt.toISOString(),
    };
    await this.outbox.record({
      type: APPROVAL_REQUEST_CHANGED,
      payload,
      metadata: { eventId: `${request.id}:${request.status}`, ...(request.projectId === null ? {} : { projectId: request.projectId }) },
    });
    if (request.projectId !== null) {
      await this.webhooks.dispatch(
        request.projectId,
        request.status === 'pending' ? 'approval.requested' : 'approval.resolved',
        approvalWebhookPayloadOf(request),
      );
    }
  }
}
