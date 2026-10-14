import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type WorkflowOutcome = 'ready' | 'draft' | 'local-only';

export interface WorkflowResult {
  readonly runId: string;
  readonly outcome: WorkflowOutcome;
  readonly reasons: readonly string[]; // at most 20, each at most 500 characters
}

/** 1 MiB: files larger than this are never read. */
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_REASONS = 20;
const MAX_REASON_CHARS = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOutcome = (v: unknown): v is WorkflowOutcome => v === 'ready' || v === 'draft' || v === 'local-only';

function clipReason(text: string): string {
  if (text.length <= MAX_REASON_CHARS) return text;
  const last = text.charCodeAt(MAX_REASON_CHARS - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_REASON_CHARS - 1 : MAX_REASON_CHARS);
}

/** null unless raw is a schemaVersion 1 result with a verdict whose outcome is one of the three values. */
export function parseWorkflowResult(raw: unknown): WorkflowResult | null {
  if (!isObj(raw) || raw['schemaVersion'] !== 1 || typeof raw['runId'] !== 'string') return null;
  const verdict = raw['verdict'];
  if (!isObj(verdict) || !isOutcome(verdict['outcome'])) return null;
  const rawReasons = Array.isArray(verdict['reasons']) ? verdict['reasons'] : [];
  const reasons = rawReasons.filter((r): r is string => typeof r === 'string').map(clipReason).slice(0, MAX_REASONS);
  return { runId: raw['runId'], outcome: verdict['outcome'], reasons };
}

/** Newest-first over `<featureDir>/workflow/<id>/result.json` (real directories, regular files, at most 1 MiB, mtime >= sinceMs): the first that parses, with its run dir. */
export async function findWorkflowResult(featureDir: string, sinceMs: number): Promise<{ result: WorkflowResult; runDir: string } | null> {
  const workflowDir = join(featureDir, 'workflow');
  let entries;
  try {
    entries = await readdir(workflowDir, { withFileTypes: true });
  } catch {
    return null;
  }
  interface Candidate {
    readonly name: string;
    readonly mtimeMs: number;
  }
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const resultPath = join(workflowDir, entry.name, 'result.json');
    let st;
    try {
      st = await lstat(resultPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_RESULT_BYTES || !(st.mtimeMs >= sinceMs)) continue;
    candidates.push({ name: entry.name, mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const resultPath = join(workflowDir, candidate.name, 'result.json');
    try {
      const text = await readFile(resultPath, 'utf8');
      const parsed = parseWorkflowResult(JSON.parse(text));
      if (parsed) return { result: parsed, runDir: join(workflowDir, candidate.name) };
    } catch {
      continue;
    }
  }
  return null;
}
