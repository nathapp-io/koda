import type { BundleFile } from '../bundle-reader';
import { INGEST_LIMITS, ReviewResultRow } from '../domain/bundle-ingest.domain';
import type { ParseResult } from './cost-ledger.parser';
import { bool, date, obj, parseJson, str } from './fields';

function countBySeverity(findings: unknown[]): Record<string, number> {
  return findings.reduce<Record<string, number>>((acc, f) => {
    const key = (str(obj(f)?.severity, 40) ?? 'unknown').toLowerCase();
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});
}

function toRow(raw: Record<string, unknown>): ReviewResultRow | null {
  const reviewer = str(raw.reviewer, INGEST_LIMITS.shortText);
  const recordId = str(raw.recordId, INGEST_LIMITS.idText);
  const at = date(raw.timestamp);
  const result = obj(raw.result) ?? {};
  const passed = bool(raw.passed) ?? bool(result.passed);
  if (!reviewer || !recordId || !at || passed === null) return null;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return {
    storyId: str(raw.storyId, INGEST_LIMITS.idText), reviewer, recordId, passed, failOpen: bool(raw.failOpen) ?? false,
    findingCount: findings.length, findingsBySeverity: countBySeverity(findings),
    advisoryCount: Array.isArray(raw.advisoryFindings) ? raw.advisoryFindings.length : 0, at,
  };
}

/** Spec §1.4, D374. */
export function parseReviews(files: readonly BundleFile[]): ParseResult<ReviewResultRow> {
  if (files.length === 0) return { rows: [], outcome: 'absent' };
  const rows = files.map((f) => obj(parseJson(f.text))).filter((r): r is Record<string, unknown> => r !== null)
    .map(toRow).filter((r): r is ReviewResultRow => r !== null);
  const unique = rows.filter((r, i) => rows.findIndex((o) => o.recordId === r.recordId) === i);
  return unique.length > INGEST_LIMITS.reviews
    ? { rows: unique.slice(0, INGEST_LIMITS.reviews), outcome: 'capped' }
    : { rows: unique, outcome: 'done' };
}
