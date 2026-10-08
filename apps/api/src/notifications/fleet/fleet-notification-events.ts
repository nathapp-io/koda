import { FleetJobState } from '../../common/enums';
import type { BudgetScopeType } from '../../fleet/budgets/domain/budget.domain';

/**
 * Fleet S4a §2.4: outbox event types the fleet enqueues for notifications, their payloads and the pure helpers
 * shared by the enqueue side (fleet modules) and the consumers (notifications/fleet). No Nest imports here, so
 * fleet modules can import it without a module cycle.
 */
export const FLEET_JOB_OUTCOME = 'fleet_job_outcome';
export const FLEET_BUDGET_INCIDENT = 'fleet_budget_incident';
export const FLEET_HEALTH_ALERT = 'fleet_health_alert';
/** Enqueued by ApprovalCloser.enqueueRequested since #236. */
export const FLEET_APPROVAL_REQUESTED = 'fleet_approval_requested';

export const JOB_OUTCOMES = ['escalated', 'failed', 'crashed', 'pr_opened'] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export const HEALTH_ALERT_KINDS = ['runner_offline', 'credential_expiring'] as const;
export type HealthAlertKind = (typeof HEALTH_ALERT_KINDS)[number];
const BUDGET_INCIDENT_KINDS = ['warn', 'hard_stop'] as const;
export type BudgetIncidentNotifyKind = (typeof BUDGET_INCIDENT_KINDS)[number];

export interface FleetJobOutcomePayload { jobId: string; leaseEpoch: number; projectId: string; requestedById: string;
  outcome: JobOutcome; repo: string; feature: string; resultPrUrl: string | null }
export interface FleetBudgetIncidentPayload { incidentId: string; kind: BudgetIncidentNotifyKind; scope: string; spentUsd: string; amountUsd: string }
export interface FleetHealthAlertPayload { alertId: string; kind: HealthAlertKind; runner: string; provider: string | null; expiresAt: string | null }
/** The fields of approvalWebhookPayload (approvals/approval-payloads.ts) the consumer needs. */
export interface FleetApprovalRequestedPayload { approvalId: string; type: string; projectId: string | null; jobId: string | null; policyId: string | null }

const FAILURE_OUTCOME: Readonly<Record<string, JobOutcome>> = Object.freeze({
  [FleetJobState.ESCALATED]: 'escalated',
  [FleetJobState.FAILED]: 'failed',
  [FleetJobState.CRASHED]: 'crashed',
});

/** S4a §2.4: which terminal states notify the requester. CANCELLED and a COMPLETED job without a PR do not. */
export function jobOutcomeOf(state: string, resultPrUrl: string | null): JobOutcome | null {
  if (Object.prototype.hasOwnProperty.call(FAILURE_OUTCOME, state)) return FAILURE_OUTCOME[state];
  return state === FleetJobState.COMPLETED && resultPrUrl ? 'pr_opened' : null;
}

export function buildJobOutcomePayload(
  job: { id: string; leaseEpoch: number; projectId: string; requestedById: string; feature: string; resultPrUrl: string | null },
  repo: string,
  outcome: JobOutcome,
): FleetJobOutcomePayload {
  return {
    jobId: job.id, leaseEpoch: job.leaseEpoch, projectId: job.projectId, requestedById: job.requestedById,
    outcome, repo, feature: job.feature, resultPrUrl: job.resultPrUrl ?? null,
  };
}

/** The BudgetIncident_threshold_key columns: stable across re-evaluations, so it is the notification source id. */
export function budgetIncidentId(policyId: string, kind: BudgetIncidentNotifyKind, windowStart: Date, amountUsd: string): string {
  return `${policyId}:${kind}:${windowStart.toISOString()}:${amountUsd}`;
}

/** `name` is the project key, `owner/name` of the repo, or the runner name; null when the row is gone. */
export function budgetScopeLabel(scopeType: BudgetScopeType, scopeId: string | null, name: string | null): string {
  if (scopeType === 'global') return 'global';
  if (name === null) return `${scopeType} ${scopeId ?? ''}`.trim();
  return scopeType === 'repo' ? name : `${scopeType} ${name}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const textOrNull = (v: unknown): string | null => (isText(v) ? v : null);
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);

export function parseJobOutcomePayload(raw: unknown): FleetJobOutcomePayload | null {
  if (!isObject(raw)) return null;
  const { jobId, leaseEpoch, projectId, requestedById, outcome, repo, feature, resultPrUrl } = raw;
  if (!isText(jobId) || !isText(projectId) || !isText(requestedById) || !isText(repo) || typeof feature !== 'string') return null;
  if (typeof leaseEpoch !== 'number' || !Number.isInteger(leaseEpoch) || !oneOf(JOB_OUTCOMES, outcome)) return null;
  return { jobId, leaseEpoch, projectId, requestedById, outcome, repo, feature, resultPrUrl: textOrNull(resultPrUrl) };
}

export function parseBudgetIncidentPayload(raw: unknown): FleetBudgetIncidentPayload | null {
  if (!isObject(raw)) return null;
  const { incidentId, kind, scope, spentUsd, amountUsd } = raw;
  if (!isText(incidentId) || !oneOf(BUDGET_INCIDENT_KINDS, kind) || !isText(scope) || !isText(spentUsd) || !isText(amountUsd)) return null;
  return { incidentId, kind, scope, spentUsd, amountUsd };
}

export function parseHealthAlertPayload(raw: unknown): FleetHealthAlertPayload | null {
  if (!isObject(raw)) return null;
  const { alertId, kind, runner, provider, expiresAt } = raw;
  if (!isText(alertId) || !oneOf(HEALTH_ALERT_KINDS, kind) || !isText(runner)) return null;
  return { alertId, kind, runner, provider: textOrNull(provider), expiresAt: textOrNull(expiresAt) };
}

export function parseApprovalRequestedPayload(raw: unknown): FleetApprovalRequestedPayload | null {
  if (!isObject(raw)) return null;
  const { approvalId, type, projectId, jobId, policyId } = raw;
  if (!isText(approvalId) || !isText(type)) return null;
  return { approvalId, type, projectId: textOrNull(projectId), jobId: textOrNull(jobId), policyId: textOrNull(policyId) };
}
