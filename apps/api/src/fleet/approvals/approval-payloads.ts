import type { FleetApprovalRecord } from './domain/approval.domain';

/** FleetActivity payload of an approval row. No `*Key` names (FleetActivityService rejects them). */
export function approvalActivityPayload(a: FleetApprovalRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: a.type, status: a.status, decision: a.decision, resolvedBy: a.resolvedBy, policyId: a.policyId, jobId: a.jobId, ...extra };
}
