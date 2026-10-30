import type { ApprovalMode } from '../../permissions/catalog';
import type { ActionOrigin } from '../../action-context/action-context';

export type ApprovalSubjectType = 'USER' | 'AGENT' | 'ASSISTANT';
export type ApprovalPolicyViolation =
  'pattern' | 'subject' | 'mode' | 'below-floor' | 'timeout' | 'timeout-approve' | 'required-approvals';
export type EligibilityRefusal =
  | 'not-a-principal' | 'assistant-cannot-decide' | 'distinct-approver-required'
  | 'missing-decide-permission' | 'missing-action-permission' | 'tier-too-low';
export interface ApprovalPolicyInput {
  projectId: string | null;
  permissionPattern: string;
  appliesTo: { kind: 'all' }
    | { kind: 'type'; principalType: ApprovalSubjectType }
    | { kind: 'role'; roleId: string }
    | { kind: 'principal'; principalType: 'USER' | 'AGENT'; principalId: string };
  mode: ApprovalMode;
  timeoutSec?: number | null;
  onTimeout?: 'reject' | 'approve';
  requiredApprovals?: number;
  approverMustHoldAction?: boolean;
  requireDistinctApprover?: boolean;
}
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'executed' | 'failed';
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 86_400;
export const APPROVAL_POLICY_REPOSITORY = Symbol('APPROVAL_POLICY_REPOSITORY');
export const APPROVAL_REQUEST_REPOSITORY = Symbol('APPROVAL_REQUEST_REPOSITORY');

export interface ApprovalPolicyRecord {
  id: string; selector: string; projectId: string | null; permissionPattern: string;
  principalType: ApprovalSubjectType | null; roleId: string | null; principalId: string | null;
  mode: ApprovalMode; timeoutSec: number | null; onTimeout: 'reject' | 'approve'; requiredApprovals: number;
  approverMustHoldAction: boolean; requireDistinctApprover: boolean;
  updatedByType: string; updatedById: string; createdAt: Date; updatedAt: Date;
}

export interface ApprovalRequestRecord {
  id: string; permissionKey: string;
  /**
   * The registered command's variant this request runs (US-001), e.g. `rest:labels.delete`. Absent
   * when the request runs its key's primary command — which is what every request opened before
   * variants existed, and every assistant and fleet ask, carries.
   */
  variant?: string;
  /**
   * Present when the request's command redeems (US-001 of `gate-secret`): approving it releases the
   * request without running anything, and the requester redeems it by re-sending the full input. Its
   * stored `input` is the command's redacted form, so no secret is in the row. Absent for every
   * execute-after-approval request, which is what every reader of the flag relies on.
   */
  redeem?: true;
  projectId: string | null;
  actor: { type: 'USER' | 'AGENT' | 'SYSTEM'; id: string };
  onBehalfOf: { type: 'USER' | 'AGENT'; id: string } | null;
  origin: ActionOrigin; correlationId: string; input: unknown; inputHash: string;
  requiredMode: ApprovalMode; policyId: string | null; onTimeout: 'reject' | 'approve';
  approverMustHoldAction: boolean; requireDistinctApprover: boolean; status: ApprovalRequestStatus;
  satisfiedBy: ApprovalMode | null; approverType: 'USER' | 'AGENT' | null; approverId: string | null;
  expiresAt: Date; decidedAt: Date | null; settledAt: Date | null; result: unknown; createdAt: Date;
}

export interface ApprovalDecisionRecord {
  id: string; requestId: string; deciderType: 'USER' | 'AGENT'; deciderId: string;
  decision: 'approve' | 'reject'; comment: string | null; decidedAt: Date;
  /** The decider's choice as the command's `parseDecision` froze it; null when the decision carried none. */
  params: unknown;
}
