import { normaliseReason, rate4 } from './analytics-window';
import type { FinishOutcomesView, FirstPassPointView, ReasonView, ReviewerView } from './analytics.types';
import { ANALYTICS_LIMITS, CountRow, FirstPassCell, ReviewerRow, ReviewerSeverityRow } from './domain/analytics.domain';

/** D381: nax finish statuses -> the spec's five outcome buckets. A Map: untrusted strings never reach a prototype. */
const FINISH_BUCKETS = new Map<string, keyof FinishOutcomesView>([
  ['opened', 'opened'], ['promoted', 'promoted'], ['already-ready', 'promoted'], ['escalated', 'escalated'],
  ['skipped', 'skipped'], ['nothing-to-finish', 'skipped'],
]);

export function finishOutcomes(rows: readonly CountRow[]): FinishOutcomesView {
  return rows.reduce<FinishOutcomesView>((acc, r) => {
    const bucket = FINISH_BUCKETS.get(r.value) ?? 'other';
    return { ...acc, [bucket]: acc[bucket] + r.count };
  }, { opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 });
}

/** Spec §4.2: reasons merged by their normalised first line; the top `limit` by count, then text. */
export function topReasons(rows: readonly CountRow[], limit: number = ANALYTICS_LIMITS.topReasons): ReasonView[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const reason = normaliseReason(r.value);
    if (reason !== '') counts.set(reason, (counts.get(reason) ?? 0) + r.count);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
    .slice(0, limit);
}

export function reviewerViews(rows: readonly ReviewerRow[], severities: readonly ReviewerSeverityRow[]): ReviewerView[] {
  return rows.map((r) => ({
    reviewer: r.reviewer,
    runs: r.runs,
    passRate: rate4(r.passed, r.runs),
    findingsBySeverity: Object.fromEntries(severities.filter((s) => s.reviewer === r.reviewer).map((s) => [s.severity, s.count])),
  }));
}

/** D378, D380: one point per bucket; null where no story completed. */
export function firstPassSeries(cells: readonly FirstPassCell[], starts: readonly Date[]): FirstPassPointView[] {
  const byT = new Map(cells.map((c): [number, FirstPassCell] => [c.t.getTime(), c]));
  return starts.map((t) => {
    const c = byT.get(t.getTime());
    return { t: t.toISOString(), rate: c ? rate4(c.firstPass, c.stories) : null };
  });
}
