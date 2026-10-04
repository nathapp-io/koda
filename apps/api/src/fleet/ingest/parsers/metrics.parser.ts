import type { BundleFile } from '../bundle-reader';
import { INGEST_LIMITS, StoryResultRow } from '../domain/bundle-ingest.domain';
import type { ParseResult } from './cost-ledger.parser';
import { bool, date, money, nonNegInt, obj, parseJson, str } from './fields';

const S = INGEST_LIMITS.shortText;
const ID = INGEST_LIMITS.idText;

function toRow(feature: string, raw: Record<string, unknown>): StoryResultRow | null {
  const storyId = str(raw.storyId, ID);
  const attempts = nonNegInt(raw.attempts);
  const success = bool(raw.success);
  if (!storyId || attempts === null || success === null) return null;
  const tokens = obj(raw.tokens) ?? {};
  return {
    featureName: feature, storyId, attempts, success, firstPassSuccess: bool(raw.firstPassSuccess) ?? false,
    complexity: str(raw.complexity, S), initialComplexity: str(raw.initialComplexity, S), modelTier: str(raw.modelTier, S),
    finalTier: str(raw.finalTier, S), modelUsed: str(raw.modelUsed, S), agentUsed: str(raw.agentUsed, S),
    costUsd: money(raw.cost) ?? '0', durationMs: nonNegInt(raw.durationMs),
    inputTokens: nonNegInt(tokens.inputTokens) ?? 0, outputTokens: nonNegInt(tokens.outputTokens) ?? 0,
    cacheReadTokens: nonNegInt(tokens.cacheReadInputTokens) ?? 0, cacheWriteTokens: nonNegInt(tokens.cacheCreationInputTokens) ?? 0,
    startedAt: date(raw.startedAt), completedAt: date(raw.completedAt),
  };
}

/** Spec §1.3, D366: the run whose runId matches, else the only run. */
export function parseMetrics(file: BundleFile | null, naxRunId: string | null): ParseResult<StoryResultRow> {
  if (!file) return { rows: [], outcome: 'absent' };
  const runs = parseJson(file.text);
  if (!Array.isArray(runs)) return { rows: [], outcome: 'invalid' };
  const objects = runs.map(obj).filter((r): r is Record<string, unknown> => r !== null);
  const run = objects.find((r) => naxRunId !== null && r.runId === naxRunId) ?? (objects.length === 1 ? objects[0] : null);
  if (!run) return { rows: [], outcome: 'done' };
  const feature = str(run.feature, ID) ?? 'unknown';
  const stories = Array.isArray(run.stories) ? run.stories.map(obj).filter((s): s is Record<string, unknown> => s !== null) : [];
  const rows = stories.map((s) => toRow(feature, s)).filter((r): r is StoryResultRow => r !== null);
  const unique = rows.filter((r, i) => rows.findIndex((o) => o.storyId === r.storyId) === i);
  return unique.length > INGEST_LIMITS.stories
    ? { rows: unique.slice(0, INGEST_LIMITS.stories), outcome: 'capped' }
    : { rows: unique, outcome: 'done' };
}
