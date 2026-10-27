import { NotificationDraft, TITLE_MAX, truncate } from '../notification.types';
import type {
  FleetBudgetIncidentPayload, FleetHealthAlertPayload, FleetJobOutcomePayload,
} from './fleet-notification-events';

/** Fleet S4a contract "Kinds, links and params": pure builders, English fallback titles (D510: no command text). */

const usd = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : v;
};

const fleetDraft = (d: Omit<NotificationDraft, 'title' | 'body' | 'actorId'> & { title: string }): NotificationDraft => ({
  ...d, title: truncate(d.title, TITLE_MAX), body: null, actorId: null,
});

export function jobOutcomeDraft(p: FleetJobOutcomePayload, slug: string): NotificationDraft {
  const pr = p.outcome === 'pr_opened';
  return fleetDraft({
    userId: p.requestedById, projectId: p.projectId, category: 'FLEET_NEEDS_YOU', kind: `job_${p.outcome}`,
    title: pr ? `Fleet job on ${p.repo} opened a PR` : `Fleet job on ${p.repo} ${p.outcome}`,
    link: `/${slug}/fleet/jobs/${p.jobId}`,
    params: pr ? { repo: p.repo, feature: p.feature, prUrl: p.resultPrUrl ?? '' } : { repo: p.repo, feature: p.feature, state: p.outcome },
    sourceType: 'fleet_job', sourceId: `${p.jobId}:${p.leaseEpoch}`,
  });
}

export function approvalDrafts(
  adminIds: readonly string[],
  a: { approvalId: string; projectId: string | null; kindLabel: string; repo: string },
): NotificationDraft[] {
  return adminIds.map((userId) => fleetDraft({
    userId, projectId: a.projectId, category: 'FLEET_NEEDS_YOU', kind: 'approval_requested',
    title: `Approval needed: ${a.kindLabel} on ${a.repo}`, link: '/admin/fleet/approvals',
    params: { repo: a.repo, kind: a.kindLabel }, sourceType: 'fleet_approval', sourceId: a.approvalId,
  }));
}

export function budgetDrafts(adminIds: readonly string[], p: FleetBudgetIncidentPayload): NotificationDraft[] {
  const spentUsd = usd(p.spentUsd);
  const amountUsd = usd(p.amountUsd);
  return adminIds.map((userId) => fleetDraft({
    userId, projectId: null, category: 'FLEET_HEALTH', kind: `budget_${p.kind}`,
    title: `Budget ${p.scope}: $${spentUsd} of $${amountUsd}`, link: '/admin/fleet/budgets',
    params: { scope: p.scope, spentUsd, amountUsd }, sourceType: 'fleet_budget_incident', sourceId: p.incidentId,
  }));
}

export function healthDrafts(adminIds: readonly string[], p: FleetHealthAlertPayload): NotificationDraft[] {
  const offline = p.kind === 'runner_offline';
  const provider = p.provider ?? '';
  const expiresAt = (p.expiresAt ?? '').slice(0, 10);
  return adminIds.map((userId) => fleetDraft({
    userId, projectId: null, category: 'FLEET_HEALTH', kind: p.kind,
    title: offline ? `Runner ${p.runner} is offline` : `${provider} credential on ${p.runner} expires ${expiresAt}`,
    link: offline ? '/admin/fleet/runners' : '/admin/fleet/credentials',
    params: offline ? { runner: p.runner } : { runner: p.runner, provider, expiresAt },
    sourceType: 'fleet_health_alert', sourceId: p.alertId,
  }));
}
