import { Prisma } from '@prisma/client';
import type { BundleFiles } from './bundle-reader';
import type { IngestRows } from './domain/bundle-ingest.domain';
import { parseCostLedger } from './parsers/cost-ledger.parser';
import { FinishInfo, parseFinish, parseStatus } from './parsers/finish.parser';
import { parseMetrics } from './parsers/metrics.parser';
import { parseReviews } from './parsers/review-audit.parser';

export interface ParsedBundle {
  naxRunId: string | null;
  runStatus: string | null;
  rows: IngestRows;
  finish: FinishInfo | null;
  files: Record<string, string>;
  partial: boolean;
  /** Unrounded sum of the parsed cost rows (A7). */
  ledgerCostUsd: string;
}

const isPartial = (outcome: string) => outcome !== 'done' && outcome !== 'absent';

/** Spec §2.3: one bundle's files -> rows + finish info + per-file outcomes. Pure. */
export function parseBundle(files: BundleFiles, fallbackRunId: string | null): ParsedBundle {
  const status = parseStatus(files.status);
  const naxRunId = status.runId ?? fallbackRunId;
  const oversized = (slot: string) => files.oversized.some((n) => n.startsWith(slot));
  const cost = parseCostLedger(files.cost);
  const metrics = oversized('nax-out/metrics.json') ? { rows: [], outcome: 'oversized' } : parseMetrics(files.metrics, naxRunId);
  const reviews = parseReviews(files.reviews);
  const finish = parseFinish(files.finishResults, files.finishLast, naxRunId);
  const outcomes: Record<string, string> = {
    cost: oversized('nax-out/cost/') && cost.outcome === 'done' ? 'partial' : cost.outcome,
    metrics: metrics.outcome,
    review: reviews.outcome,
    finish: finish ? 'done' : 'absent',
  };
  const ledger = cost.rows.reduce((sum, r) => sum.add(r.costUsd), new Prisma.Decimal(0));
  return {
    naxRunId,
    runStatus: status.runStatus,
    rows: { costEvents: cost.rows, stories: metrics.rows, reviews: reviews.rows },
    finish,
    files: outcomes,
    partial: Object.values(outcomes).some(isPartial) || files.oversized.length > 0,
    ledgerCostUsd: ledger.toFixed(),
  };
}
