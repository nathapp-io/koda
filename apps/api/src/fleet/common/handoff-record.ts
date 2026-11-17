import type { HandoffRecordFile } from '@nathapp/fleet-protocol';

/**
 * US-003 (#477): the handoff record as the domain value.
 *
 * The record lives in the chat checkout (`.nax/features/<feature>/workflow/<runId>/`), which is
 * git-excluded, so it travels with the request and is stored in a JSON column. A JSON column is
 * unconstrained, so a stored value is read through this shape guard: an entry this app did not
 * write is absent (null), never an unchecked assertion.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The file names are the protocol's; the API image does not ship `@nathapp/fleet-protocol`, so they
 * are spelled out here and pinned equal to the package's by `src/fleet/common/protocol.spec.ts`.
 */
const RECORD_FILES: readonly HandoffRecordFile['file'][] = ['result.json', 'ledger.md'];

/** The stored handoff record, or null when the column holds nothing this app wrote. */
export function handoffRecordOf(value: unknown): HandoffRecordFile[] | null {
  // An empty array is no record: the dispatch needs a record to restore, so it reads as absent.
  if (!Array.isArray(value) || value.length === 0) return null;
  const record: HandoffRecordFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { runId, file, mtimeMs, content } = entry;
    if (typeof runId !== 'string' || runId.length === 0) return null;
    if (typeof file !== 'string' || !RECORD_FILES.includes(file as HandoffRecordFile['file'])) return null;
    if (typeof mtimeMs !== 'number' || !Number.isInteger(mtimeMs) || mtimeMs < 0) return null;
    if (typeof content !== 'string') return null;
    record.push({ runId, file: file as HandoffRecordFile['file'], mtimeMs, content });
  }
  return record;
}
