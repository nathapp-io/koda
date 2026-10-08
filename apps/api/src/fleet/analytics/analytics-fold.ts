import { Prisma } from '../../generated/prisma/client';
import { usd4 } from './analytics-window';
import type { SpendSeriesView } from './analytics.types';
import { ANALYTICS_LIMITS, OTHER_KEY, SpendCell } from './domain/analytics.domain';

const ZERO = new Prisma.Decimal(0);
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function rankedKeys(cells: readonly SpendCell[]): string[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const c of cells) totals.set(c.key, (totals.get(c.key) ?? ZERO).add(c.costUsd));
  return [...totals]
    .sort(([ka, a], [kb, b]) => b.cmp(a) || byKey(ka, kb))
    .map(([key]) => key);
}

function toSeries(key: string, label: string, folded: boolean, cells: readonly SpendCell[], starts: readonly Date[]): SpendSeriesView {
  const byT = new Map<number, { cost: Prisma.Decimal; tokens: number }>();
  for (const c of cells) {
    const prev = byT.get(c.t.getTime()) ?? { cost: ZERO, tokens: 0 };
    byT.set(c.t.getTime(), { cost: prev.cost.add(c.costUsd), tokens: prev.tokens + c.tokens });
  }
  const points = starts.map((t) => {
    const v = byT.get(t.getTime());
    return { t: t.toISOString(), costUsd: usd4(v ? v.cost : ZERO), tokens: v ? v.tokens : 0 };
  });
  const cost = cells.reduce((sum, c) => sum.add(c.costUsd), ZERO);
  const tokens = cells.reduce((sum, c) => sum + c.tokens, 0);
  return { key, label, folded, costUsd: usd4(cost), tokens, points };
}

/** Spec §4.2, D377-D378: the top `keep` keys by cost, the rest folded into one `other` series; sums before rounding. */
export function foldSeries(
  cells: readonly SpendCell[], starts: readonly Date[], labels: ReadonlyMap<string, string>, keep: number = ANALYTICS_LIMITS.seriesKeep,
): SpendSeriesView[] {
  const kept = rankedKeys(cells).slice(0, keep);
  const keptSet = new Set(kept);
  const series = kept.map((key) => toSeries(key, labels.get(key) ?? key, false, cells.filter((c) => c.key === key), starts));
  const rest = cells.filter((c) => !keptSet.has(c.key));
  return rest.length === 0 ? series : [...series, toSeries(OTHER_KEY, OTHER_KEY, true, rest, starts)];
}
