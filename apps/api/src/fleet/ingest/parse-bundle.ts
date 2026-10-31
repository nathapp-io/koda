import { Prisma } from '../../generated/prisma/client';
import type { BundleFiles } from './bundle-reader';
import type { IngestRows, RunOutcomeRow } from './domain/bundle-ingest.domain';
import { RUN_OUTCOME_MAX_CHARS } from './domain/bundle-ingest.domain';
import type { FleetJobWorkflow } from '../jobs/domain/fleet-job.domain';
import { parseCostLedger } from './parsers/cost-ledger.parser';
import { clipString } from './parsers/fields';
import { FinishInfo, parseFinish, parseStatus } from './parsers/finish.parser';
import { parseMetrics } from './parsers/metrics.parser';
import { parseReviews } from './parsers/review-audit.parser';
import { parseWorkflowResult } from './parsers/workflow.parser';
import { parseBotReview, type BotReviewParse } from './parsers/bot-review.parser';

export interface ParsedBundle {
  naxRunId: string | null;
  runStatus: string | null;
  workflow: FleetJobWorkflow | null;
  workflowOutcome: 'ready' | 'draft' | 'local-only' | null;
  workflowUrl: string | null;
  rows: IngestRows;
  finish: FinishInfo | null;
  files: Record<string, string>;
  partial: boolean;
  /** Unrounded sum of the parsed cost rows (A7). */
  ledgerCostUsd: string;
  botReview?: BotReviewParse;
}

const isPartial = (outcome: string) => outcome !== 'done' && outcome !== 'absent';

/** Spec §2.3: one bundle's files -> rows + finish info + per-file outcomes. Pure. */
export function parseBundle(files: BundleFiles, fallbackRunId: string | null, opts: { reviewPrNumber?: number } = {}): ParsedBundle {
  const status = parseStatus(files.status);
  const naxRunId = status.runId ?? fallbackRunId;
  const oversized = (slot: string) => files.oversized.some((n) => n.startsWith(slot));
  const cost = parseCostLedger(files.cost);
  const metrics = oversized('nax-out/metrics.json') ? { rows: [], outcome: 'oversized' } : parseMetrics(files.metrics, naxRunId);
  const reviews = parseReviews(files.reviews);
  const finish = parseFinish(files.finishResults, files.finishLast, naxRunId);
  const workflow = parseWorkflowResult(files.workflowResult);
  const botReview = opts.reviewPrNumber === undefined ? undefined : parseBotReview(files, opts.reviewPrNumber);
  const workflowOutcome = status.workflowOutcome;
  const workflowUrl = status.workflowUrl;
  const workflowOutcomeFile = files.workflowResult ? (workflow ? 'done' : 'invalid') : 'absent';
  const outcomes: Record<string, string> = {
    cost: oversized('nax-out/cost/') && cost.outcome === 'done' ? 'partial' : cost.outcome,
    metrics: metrics.outcome,
    review: reviews.outcome,
    finish: finish ? 'done' : 'absent',
    workflow: workflowOutcomeFile,
    ...(botReview ? { botReview: botReview.outcome } : {}),
  };
  const ledger = cost.rows.reduce((sum, r) => sum.add(r.costUsd), new Prisma.Decimal(0));
  // S5b 3c-2-D1: one bounded row per non-empty RUN outcome file, report first. Files and partial are unaffected.
  const outcomeRows: RunOutcomeRow[] = [];
  if (files.featureReport?.text) outcomeRows.push({ kind: 'report', content: clipString(files.featureReport.text, RUN_OUTCOME_MAX_CHARS) });
  if (files.decisions?.text) outcomeRows.push({ kind: 'decisions', content: clipString(files.decisions.text, RUN_OUTCOME_MAX_CHARS) });
  // US-005: an invalid workflow/result.json never makes the ingest partial.
  const partial = Object.entries(outcomes).some(([key, outcome]) => key !== 'workflow' && key !== 'botReview' && isPartial(outcome)) || files.oversized.length > 0;
  return {
    naxRunId,
    runStatus: status.runStatus,
    workflow,
    workflowOutcome,
    workflowUrl,
    rows: { costEvents: cost.rows, stories: metrics.rows, reviews: reviews.rows, outcomes: outcomeRows },
    finish,
    files: outcomes,
    partial,
    ledgerCostUsd: ledger.toFixed(),
    ...(botReview ? { botReview } : {}),
  };
}
