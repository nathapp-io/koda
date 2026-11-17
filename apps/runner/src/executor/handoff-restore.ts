import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HANDOFF_RECORD_FILES, HANDOFF_RUN_ID_RE, type AssignPayload, type HandoffRecordFile } from '@nathapp/fleet-protocol';
import { featureDirFor } from '../paths/safe-segment';

/**
 * flow-handoff US-007: the mtime an entry may carry. It is the Date range `utimes` accepts, so the runner restores
 * the sender's clock exactly and nax's newest-first order stays the sender's order.
 */
const MAX_MTIME_MS = 8640000000000000;

/**
 * The shape of an entry is checked again here, before the first byte is written: the record arrives over the wire,
 * and a run id is a path segment of the checkout.
 */
function assertEntry(entry: HandoffRecordFile): void {
  if (typeof entry.runId !== 'string' || !HANDOFF_RUN_ID_RE.test(entry.runId)) throw new Error('invalid handoff run id');
  if (typeof entry.file !== 'string' || !(HANDOFF_RECORD_FILES as readonly string[]).includes(entry.file)) throw new Error('invalid handoff file');
  if (typeof entry.mtimeMs !== 'number' || !Number.isInteger(entry.mtimeMs) || entry.mtimeMs < 0 || entry.mtimeMs > MAX_MTIME_MS) throw new Error('invalid handoff mtime');
  if (typeof entry.content !== 'string') throw new Error('invalid handoff content');
}

/**
 * flow-handoff US-007: the record of the chat run a handoff flow took over.
 *
 * The record lives in `.nax/features/<feature>/workflow/<runId>/`, which is git-excluded, so it travels with the
 * assignment and is restored into the checkout before nax starts. The runner's `clean -ffd` keeps git-ignored files,
 * so earlier jobs' run directories survive in the clone: the whole `workflow` folder is replaced, so `--publish-only`
 * reads the sender's record and nothing else.
 */
export async function restoreHandoffRecord(repoDir: string, feature: string, record: readonly HandoffRecordFile[]): Promise<void> {
  const workflowDir = join(featureDirFor(repoDir, feature), 'workflow');
  for (const entry of record) assertEntry(entry);   // before any filesystem use
  await rm(workflowDir, { recursive: true, force: true });
  await mkdir(workflowDir, { recursive: true });
  for (const entry of record) {
    const runDir = join(workflowDir, entry.runId);
    await mkdir(runDir, { recursive: true });
    const path = join(runDir, entry.file);
    await writeFile(path, entry.content, { flag: 'wx' });
    const seconds = entry.mtimeMs / 1000;
    await utimes(path, seconds, seconds);   // the atime and the mtime, as the sender had them
  }
}

/**
 * flow-handoff US-007: the run ids the restored record holds. A run directory of one of them is never this job's own
 * result, so it is excluded from the workflow result and the workflow stash.
 */
export function handoffRunIds(assign: AssignPayload): ReadonlySet<string> {
  const record = assign.handoff?.record;
  if (record === undefined) return new Set<string>();
  return new Set(record.map((entry) => entry.runId));
}
