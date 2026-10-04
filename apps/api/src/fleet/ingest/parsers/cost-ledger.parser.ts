import type { BundleFile } from '../bundle-reader';
import { CostEventRow, INGEST_LIMITS } from '../domain/bundle-ingest.domain';
import { date, money, nonNegInt, obj, parseJson, str } from './fields';

export interface ParseResult<T> {
  rows: T[];
  outcome: string;
}

const SUPPORTED_VERSIONS = new Set([8]);
const S = INGEST_LIMITS.shortText;
const ID = INGEST_LIMITS.idText;

function toRow(raw: Record<string, unknown>): CostEventRow | null {
  const tokens = obj(raw.tokens) ?? {};
  const at = date(raw.ts);
  const agentName = str(raw.agentName, S);
  const model = str(raw.model, S);
  const stage = str(raw.stage, S);
  const featureName = str(raw.featureName, ID);
  const callId = str(raw.callId, ID);
  const costUsd = money(raw.costUsd);
  if (!at || !agentName || !model || !stage || !featureName || !callId || costUsd === null) return null;
  return {
    at, agentName, model, stage, featureName, callId, costUsd,
    modelTier: str(raw.modelTier, S), profile: str(raw.profile, S), sessionRole: str(raw.sessionRole, S), storyId: str(raw.storyId, ID),
    inputTokens: nonNegInt(tokens.input) ?? 0, outputTokens: nonNegInt(tokens.output) ?? 0,
    cacheReadTokens: nonNegInt(tokens.cacheRead) ?? 0, cacheWriteTokens: nonNegInt(tokens.cacheWrite) ?? 0,
    pricingSource: str(raw.pricingSource, S), confidence: str(raw.confidence, S), durationMs: nonNegInt(raw.durationMs),
  };
}

/** Spec §2.3: every `cost/*.jsonl`; an unsupported schemaVersion skips its whole file; duplicate callIds keep the first. */
export function parseCostLedger(files: readonly BundleFile[]): ParseResult<CostEventRow> {
  if (files.length === 0) return { rows: [], outcome: 'absent' };
  const seen = new Set<string>();
  const rows: CostEventRow[] = [];
  let skipped: string | null = null;
  for (const f of files) {
    const parsed = f.text.split('\n').filter((l) => l.trim().length > 0).map(parseJson).map(obj).filter((r): r is Record<string, unknown> => r !== null);
    const version = parsed.length > 0 ? parsed[0].schemaVersion : 8;
    if (!SUPPORTED_VERSIONS.has(version as number)) {
      skipped = `skipped:v${String(version).slice(0, 10)}`;
      continue;
    }
    for (const raw of parsed) {
      const row = toRow(raw);
      if (!row || seen.has(row.callId)) continue;
      if (rows.length >= INGEST_LIMITS.costEvents) return { rows, outcome: 'capped' };
      seen.add(row.callId);
      rows.push(row);
    }
  }
  return { rows, outcome: skipped && rows.length === 0 ? skipped : skipped ? 'partial' : 'done' };
}
