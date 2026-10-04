import { posix } from 'path';
import type { BundleFile } from '../bundle-reader';
import { INGEST_LIMITS } from '../domain/bundle-ingest.domain';
import { obj, parseJson, str } from './fields';

export interface StatusInfo {
  runId: string | null;
  runStatus: string | null;
}

export interface FinishInfo {
  status: string;
  escalationReason: string | null;
  prUrl: string | null;
  branch: string | null;
  headSha: string | null;
}

export function parseStatus(file: BundleFile | null): StatusInfo {
  const run = obj(obj(file ? parseJson(file.text) : null)?.run);
  return { runId: str(run?.id, INGEST_LIMITS.idText), runStatus: str(run?.status, INGEST_LIMITS.shortText) };
}

const https = (v: unknown): string | null => {
  const s = str(v, INGEST_LIMITS.reasonText);
  return s && s.startsWith('https://') ? s : null;
};

function toInfo(raw: Record<string, unknown>): FinishInfo | null {
  const status = str(raw.status, INGEST_LIMITS.shortText);
  if (!status) return null;
  return {
    status,
    escalationReason: str(raw.escalationReason, INGEST_LIMITS.reasonText),
    prUrl: https(raw.url) ?? https(raw.prUrl),
    branch: str(raw.branch, INGEST_LIMITS.idText),
    headSha: str(raw.headSha, INGEST_LIMITS.idText),
  };
}

/** Spec §3.2, D366: `<runId>.result.json`, else a `last.json` whose runId matches; null otherwise. */
export function parseFinish(results: readonly BundleFile[], last: readonly BundleFile[], naxRunId: string | null): FinishInfo | null {
  if (!naxRunId) return null;
  const own = results.find((f) => posix.basename(f.name) === `${naxRunId}.result.json`);
  const fromResult = own ? obj(parseJson(own.text)) : null;
  if (fromResult) return toInfo(fromResult);
  const match = last.map((f) => obj(parseJson(f.text))).find((r) => r !== null && r.runId === naxRunId);
  return match ? toInfo(match) : null;
}
