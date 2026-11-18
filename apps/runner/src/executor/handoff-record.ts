import { HANDOFF_MAX_RUNS, HANDOFF_RECORD_MAX_BYTES, HANDOFF_RECORD_FILES, HANDOFF_RUN_ID_RE, isStorableRecordText, type HandoffRecordFile } from '@nathapp/fleet-protocol';

/**
 * flow-handoff US-007: the mtime an entry may carry. It is the Date range `utimes` accepts, so the runner can
 * restore the sender's clock exactly.
 */
const HANDOFF_MAX_MTIME_MS = 8640000000000000;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * flow-handoff US-007: the record of the chat run a handoff flow took over, checked as a whole.
 *
 * The record travels with the ASSIGN (the files it holds live in a git-excluded folder), so its shape is
 * re-checked with the protocol's limits and the API's own entry rules before a byte of it reaches the
 * filesystem. The newest run's content preconditions stay with the API (it owns the create) and the final
 * HEAD/content refusal stays with nax (it owns `--publish-only`); the runner checks the shape only.
 *
 * The whole record is checked, not one entry at a time: the record's own limits (the run count, the byte
 * budget) and its invariants (one file per run, a result.json for every run) only hold for the record as a
 * whole, and a restore that deleted the checkout's workflow folder before it knew the record was sound
 * would leave the checkout with half a record.
 */
export function validateHandoffRecord(value: unknown): HandoffRecordFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const spellings = new Map<string, string>();   // folded run id -> the spelling that carries it
  const files = new Set<string>();               // folded run id + file: one entry per file
  const resultRuns = new Set<string>();          // folded run ids that carry a result.json
  let totalBytes = 0;
  const record: HandoffRecordFile[] = [];
  for (const entry of value) {
    if (!isObj(entry)) return null;
    const runId = entry['runId'];
    if (typeof runId !== 'string' || !HANDOFF_RUN_ID_RE.test(runId)) return null;
    const folded = runId.toLowerCase();
    const spelling = spellings.get(folded);
    // A macOS runner's filesystem folds case, so one run id may not carry two spellings.
    if (spelling !== undefined && spelling !== runId) return null;
    spellings.set(folded, runId);
    const file = entry['file'];
    if (typeof file !== 'string' || !(HANDOFF_RECORD_FILES as readonly string[]).includes(file)) return null;
    const identity = `${folded}/${file}`;
    if (files.has(identity)) return null;         // the same file of the same run twice
    files.add(identity);
    const mtimeMs = entry['mtimeMs'];
    if (typeof mtimeMs !== 'number' || !Number.isInteger(mtimeMs) || mtimeMs < 0 || mtimeMs > HANDOFF_MAX_MTIME_MS) return null;
    const content = entry['content'];
    // The protocol's own rule: the text has to be storable as it is (JSONB on the API's side, UTF-8
    // on this one), so a file is never rewritten to make it fit.
    if (typeof content !== 'string' || !isStorableRecordText(content)) return null;
    totalBytes += utf8Bytes(content);
    if (file === 'result.json') resultRuns.add(folded);
    record.push({ runId, file: file as HandoffRecordFile['file'], mtimeMs, content });
  }
  if (spellings.size > HANDOFF_MAX_RUNS || totalBytes > HANDOFF_RECORD_MAX_BYTES) return null;
  // Every run the record carries needs its result.json: a ledger without one describes no run.
  if (resultRuns.size === 0) return null;
  for (const entry of record) {
    if (entry.file === 'ledger.md' && !resultRuns.has(entry.runId.toLowerCase())) return null;
  }
  return record;
}
