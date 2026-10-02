import type { FleetApprovalRecord } from './domain/approval.domain';

export const approvalPath = (slug: string, id: string): string => `/${slug}/fleet/approvals?id=${encodeURIComponent(id)}`;

/** FleetActivity payload of an approval row. No `*Key` names (FleetActivityService rejects them). */
export function approvalActivityPayload(a: FleetApprovalRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: a.type, status: a.status, decision: a.decision, resolvedBy: a.resolvedBy, policyId: a.policyId, jobId: a.jobId, ...extra };
}

/** Body of fleet.approval.requested / fleet.approval.resolved (spec §2.5). Never payload content (A8). */
export function approvalWebhookPayload(a: FleetApprovalRecord, slug: string): Record<string, unknown> {
  return {
    approvalId: a.id, type: a.type, status: a.status, decision: a.decision, resolvedBy: a.resolvedBy, projectId: a.projectId,
    jobId: a.jobId, policyId: a.policyId, expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null, path: approvalPath(slug, a.id),
  };
}
