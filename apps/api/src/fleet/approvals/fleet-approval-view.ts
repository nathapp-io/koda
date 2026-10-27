import type { Prisma } from '../../generated/prisma/client';
import type { ApprovalDecisionRecord, ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';
import {
  APPROVAL_RESOLVED_BY, CANCELLING_RESOLUTIONS, FLEET_ASK_KEY, FLEET_ASK_KEYS, fleetTypeOfKey,
  type ApprovalDecision, type ApprovalResolvedBy, type ApprovalStatus, type FleetApprovalRecord,
} from './domain/approval.domain';

/**
 * Permissions P3 (US-002): the fleet row is a *view* over an approval request, its `FleetApprovalAsk`
 * link and its last decision. This module is the only place that decides what a fleet status and a
 * fleet decision mean, so the row a client reads and the filter that listed it cannot disagree.
 */
export interface FleetAskRow {
  request: ApprovalRequestRecord;
  link: FleetApprovalAskRecord;
  /** The request's last decision row, or null. */
  decision: ApprovalDecisionRecord | null;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The fleet type of a request, from the catalog key it was opened with. */
function fleetTypeOf(permissionKey: string): FleetApprovalRecord['type'] {
  const type = fleetTypeOfKey(permissionKey);
  // The readers filter on FLEET_ASK_KEYS, so any other key is a programming error, not a row to label.
  if (type === null) throw new Error(`not a fleet ask key: ${permissionKey}`);
  return type;
}

/** `cancelled` for a cancelling link resolution, `approved` for a manual resume, else the request's own. */
function fleetStatusOf(request: ApprovalRequestRecord, link: FleetApprovalAskRecord): ApprovalStatus {
  if (link.resolvedBy !== null) {
    if (link.resolvedBy === 'manual_resume') return 'approved';
    if (CANCELLING_RESOLUTIONS.includes(link.resolvedBy)) return 'cancelled';
  }
  switch (request.status) {
    case 'pending': return 'pending';
    case 'approved':
    case 'executed': return 'approved';
    case 'rejected': return 'rejected';
    case 'expired': return 'expired';
    // 'cancelled' and 'failed': the engine gives up on a request without a decision.
    default: return 'cancelled';
  }
}

/**
 * What the fleet calls the decision: a manual resume on the budget route, else the last decision row.
 * A bash approve with no params is `allow`, so the generic decide route can allow an ask without
 * knowing the fleet's choice names.
 */
function fleetDecisionOf(request: ApprovalRequestRecord, link: FleetApprovalAskRecord, decision: ApprovalDecisionRecord | null): ApprovalDecision | null {
  if (link.resolvedBy === 'manual_resume') return 'raise_budget_and_resume';
  if (decision === null) return null;
  if (decision.decision === 'reject') return request.permissionKey === FLEET_ASK_KEY.nax_bash_escalate ? 'deny' : 'keep_paused';
  if (request.permissionKey === FLEET_ASK_KEY.budget_override_required) return 'raise_budget_and_resume';
  return asObject(decision.params)?.['choice'] === 'allow_for_job' ? 'allow_for_job' : 'allow';
}

/**
 * The resolution the fleet reports. A decided request is resolved by the decider as soon as the engine
 * has its decision, so a response never waits for the fleet's recorder to stamp the link.
 */
function resolvedByOf(request: ApprovalRequestRecord, link: FleetApprovalAskRecord): ApprovalResolvedBy | null {
  if (link.resolvedBy !== null) return link.resolvedBy;
  if (request.status === 'expired') return 'timeout';
  if (request.status === 'rejected' || request.status === 'executed' || request.status === 'failed') return 'user';
  return null;
}

/** Bash asks carry nax's payload; a budget ask's payload is its input minus the two request-owned keys. */
function payloadOf(request: ApprovalRequestRecord): Record<string, unknown> {
  const input = asObject(request.input);
  if (request.permissionKey !== FLEET_ASK_KEY.budget_override_required) return asObject(input?.['payload']) ?? {};
  const { policyId: _policyId, requestedAt: _requestedAt, ...rest } = input ?? {};
  return rest;
}

export function toFleetApproval(row: FleetAskRow): FleetApprovalRecord {
  const { request, link, decision } = row;
  const manualResume = link.resolvedBy === 'manual_resume';
  const resumedById = asObject(link.outcome)?.['resumedById'];

  return {
    id: request.id,
    type: fleetTypeOf(request.permissionKey),
    status: fleetStatusOf(request, link),
    projectId: request.projectId,
    jobId: link.jobId,
    leaseEpoch: link.leaseEpoch,
    naxAskId: link.naxAskId,
    policyId: link.budgetPolicyId,
    payload: payloadOf(request),
    outcome: link.outcome,
    requestedAt: request.createdAt,
    expiresAt: request.expiresAt,
    decision: fleetDecisionOf(request, link, decision),
    decidedById: manualResume ? (typeof resumedById === 'string' ? resumedById : null) : (decision?.deciderId ?? null),
    decidedAt: decision?.decidedAt ?? request.settledAt,
    resolvedBy: resolvedByOf(request, link),
    comment: decision?.comment ?? null,
    createdAt: request.createdAt,
    updatedAt: link.updatedAt,
  };
}

/**
 * The link resolutions the mapper's precedence applies *first*: a manual resume makes the row approved
 * and a cancelling resolution makes it cancelled, whatever the request status. The rest — `user`,
 * `timeout` — leave the request status in charge, and so does an unresolved link.
 */
const STATUS_IN_CHARGE: readonly ApprovalResolvedBy[] = APPROVAL_RESOLVED_BY.filter(
  (resolvedBy) => resolvedBy !== 'manual_resume' && !CANCELLING_RESOLUTIONS.includes(resolvedBy),
);

/**
 * "The request status decides": a link that never resolved, or resolved without overriding the status.
 * The null case is spelled out because `in` drops NULLs in SQL, so a pending link would otherwise fall
 * out of every comparison.
 */
const STATUS_IN_CHARGE_FILTER: Prisma.FleetApprovalAskWhereInput = {
  OR: [{ resolvedBy: null }, { resolvedBy: { in: [...STATUS_IN_CHARGE] } }],
};

const MANUAL_RESUME_FILTER: Prisma.FleetApprovalAskWhereInput = { resolvedBy: 'manual_resume' };
const CANCELLING_FILTER: Prisma.FleetApprovalAskWhereInput = { resolvedBy: { in: [...CANCELLING_RESOLUTIONS] } };

/** A link that exists. The branch's own relation filter is merged beside it, never instead of it. */
const BASE = {
  permissionKey: { in: [...FLEET_ASK_KEYS] },
  fleetAsk: { isNot: null },
} satisfies Prisma.ApprovalRequestWhereInput;

/**
 * One fleet status, mirroring `fleetStatusOf` exactly: every alternative carries the same link
 * precedence the mapper applies, so a status filter lists precisely the rows that map to it.
 */
const branch = (status: ApprovalStatus): Prisma.ApprovalRequestWhereInput => {
  switch (status) {
    case 'pending': return { status: 'pending', fleetAsk: STATUS_IN_CHARGE_FILTER };
    case 'expired': return { status: 'expired', fleetAsk: STATUS_IN_CHARGE_FILTER };
    case 'approved':
      return {
        OR: [
          { status: { in: ['approved', 'executed'] }, fleetAsk: STATUS_IN_CHARGE_FILTER },
          { fleetAsk: MANUAL_RESUME_FILTER },
        ],
      };
    case 'rejected': return { status: 'rejected', fleetAsk: STATUS_IN_CHARGE_FILTER };
    case 'cancelled':
      return {
        OR: [
          // A cancelling resolution wins over the request status, a manual resume included.
          { fleetAsk: CANCELLING_FILTER },
          { status: { in: ['cancelled', 'failed'] }, fleetAsk: STATUS_IN_CHARGE_FILTER },
        ],
      };
  }
};

/** The `where` for one fleet status over `ApprovalRequest` (relation `fleetAsk`). */
export function fleetStatusWhere(status: ApprovalStatus): Prisma.ApprovalRequestWhereInput {
  // The branch sits inside `AND` so its own `fleetAsk` filter is a second condition beside the base's
  // "the link exists", not a replacement for it: a fleet-key request without a link matches neither.
  return { ...BASE, AND: [branch(status)] };
}
