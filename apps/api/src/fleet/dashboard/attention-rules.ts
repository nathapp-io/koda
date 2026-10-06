import { jobApprovalItems, jobSilentItems } from './attention-jobs';
import { runnerUnhealthyItems } from './attention-runners';
import { DryRunInput, jobUnplaceableItems } from './attention-unplaceable';
import {
  AttentionItem, AttentionThresholds, DashboardJobRow, DashboardRunnerRow, DashboardScope, PendingSummary, RunnerCondition, Severity,
} from './dashboard.types';

export interface AttentionInput {
  scope: DashboardScope;
  /** Every runner (both scopes). */
  runners: readonly DashboardRunnerRow[];
  /** Runner-held job count per runner, across all projects. */
  heldByRunner: ReadonlyMap<string, number>;
  /** Active jobs in scope (the fetched list, at most 200; D403). */
  activeJobs: readonly DashboardJobRow[];
  pending: ReadonlyMap<string, PendingSummary>;
  /** Global dry-run inputs (the window is not scoped; items are filtered after). */
  dryRun: Omit<DryRunInput, 'runners'>;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1 };

const compareSince = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
};

/** Spec §1.2: errors first, then oldest `since` (unknown last), then `key`. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || compareSince(a.since, b.since) || a.key.localeCompare(b.key));
}

/**
 * Spec §2.4 / §1.5 (B5): in project scope a runner item keeps only `offline`; credential, interaction and stale_nax
 * collapse into one `configuration`; the credential and interaction error escalation is admin-only.
 */
export function forProjectScope(item: AttentionItem): AttentionItem {
  if (item.kind !== 'runner_unhealthy' || !item.conditions) return item;
  const offline = item.conditions.filter((c) => c.type === 'offline');
  const configuration: RunnerCondition[] = item.conditions.some((c) => c.type !== 'offline') ? [{ type: 'configuration' }] : [];
  const severity: Severity = offline.some((c) => (c.jobsHeld ?? 0) > 0) ? 'error' : 'warning';
  return { ...item, severity, conditions: [...offline, ...configuration] };
}

export function buildAttention(input: AttentionInput, now: Date, t: AttentionThresholds): AttentionItem[] {
  const runnersById = new Map(input.runners.map((r) => [r.id, r] as const));
  const dry = jobUnplaceableItems({ ...input.dryRun, runners: input.runners }, now, t);
  const projectId = input.scope.kind === 'project' ? input.scope.projectId : null;
  const unplaceable = dry.items.filter((s) => projectId === null || s.projectId === projectId).map((s) => s.item);
  const runnerItems = runnerUnhealthyItems(input.runners, input.heldByRunner, dry.fixableBlockedRunnerIds, now, t);
  return sortAttention([
    ...jobSilentItems(input.activeJobs, runnersById, now, t),
    ...jobApprovalItems(input.activeJobs, input.pending, now),
    ...unplaceable,
    ...(projectId === null ? runnerItems : runnerItems.map(forProjectScope)),
  ]);
}
