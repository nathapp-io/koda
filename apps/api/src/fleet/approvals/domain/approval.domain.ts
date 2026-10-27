export const APPROVAL_TYPES = ['budget_override_required', 'nax_bash_escalate'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused', 'approve', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_RESOLVED_BY = ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'] as const;
export type ApprovalResolvedBy = (typeof APPROVAL_RESOLVED_BY)[number];

/**
 * Permissions P3 (US-002): the engine key of each fleet approval type. The fleet row is a view over an
 * `ApprovalRequest`, so the type is decided by the key the request was opened with.
 */
export const FLEET_ASK_KEY = {
  nax_bash_escalate: 'fleet.job.shell.escalate',
  budget_override_required: 'fleet.budget.override',
} as const;
export const FLEET_ASK_KEYS: readonly string[] = Object.values(FLEET_ASK_KEY);

/**
 * The reverse of `FLEET_ASK_KEY`: the type a request is labelled with, from the key it was opened with.
 * The readers that query `ApprovalRequest` directly (home, assistant project counts) label a row with it
 * instead of copying the mapping.
 */
export const FLEET_ASK_TYPE: Readonly<Record<string, ApprovalType>> = Object.freeze({
  [FLEET_ASK_KEY.nax_bash_escalate]: 'nax_bash_escalate',
  [FLEET_ASK_KEY.budget_override_required]: 'budget_override_required',
});

/** The fleet type of a permission key, or null when the key is not a fleet ask's. */
export function fleetTypeOfKey(permissionKey: string): ApprovalType | null {
  // An own-property check, not a lookup: a key such as `constructor` or `toString` would otherwise answer an
  // inherited `Object.prototype` member instead of null.
  return Object.hasOwn(FLEET_ASK_TYPE, permissionKey) ? FLEET_ASK_TYPE[permissionKey] ?? null : null;
}

/** A link resolution that makes the fleet status `cancelled` whatever the request status. */
export const CANCELLING_RESOLUTIONS: readonly ApprovalResolvedBy[] = ['job_ended', 'superseded', 'policy_deleted', 'window_reset'];

/** Ceiling on how many cancelled jobs one approval may offer for re-queue. */
export const MAX_REQUEUE_CANDIDATES = 200;

/** S1.5 §1.1. Money inside `payload` and `outcome` stays a decimal string. */
export interface FleetApprovalRecord {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  projectId: string | null;
  jobId: string | null;
  leaseEpoch: number | null;
  naxAskId: string | null;
  policyId: string | null;
  payload: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  requestedAt: Date;
  expiresAt: Date | null;
  decision: ApprovalDecision | null;
  decidedById: string | null;
  decidedAt: Date | null;
  resolvedBy: ApprovalResolvedBy | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalFilters {
  projectId?: string;
  status?: ApprovalStatus;
  type?: ApprovalType;
  jobId?: string;
}

/** A cancelled-before-start job a policy may offer back for re-queue. */
export interface RequeueCandidate {
  jobId: string;
  projectId: string;
  feature: string;
  queuedAt: Date;
}

export interface PendingCount {
  projectId: string;
  slug: string;
  pending: number;
}
