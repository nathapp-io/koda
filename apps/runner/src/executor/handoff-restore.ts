import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AssignPayload, type HandoffRecordFile } from '@nathapp/fleet-protocol';
import { validateHandoffRecord } from './handoff-record';
import { featureDirFor } from '../paths/safe-segment';

/**
 * flow-handoff US-007: the record of the chat run a handoff flow took over.
 *
 * The record lives in `.nax/features/<feature>/workflow/<runId>/`, which is git-excluded, so it travels with the
 * assignment and is restored into the checkout before nax starts. The runner's `clean -ffd` keeps git-ignored files,
 * so earlier jobs' run directories survive in the clone: the whole `workflow` folder is replaced, so `--publish-only`
 * reads the sender's record and nothing else.
 */
export async function restoreHandoffRecord(repoDir: string, feature: string, record: readonly HandoffRecordFile[]): Promise<void> {
  // The record is checked as a whole before the checkout is touched. The limits and the invariants of a record
  // (the run count, the byte budget, one file per run, a result.json for every run) only hold for the record as a
  // whole, so a record that breaks one of them must not delete the workflow folder and then fail halfway through
  // the restore. The production path is protected twice: `parseAssign` checks the same rules on the ASSIGN.
  const validated = validateHandoffRecord(record);
  if (validated === null) throw new Error('invalid handoff record');
  const workflowDir = join(featureDirFor(repoDir, feature), 'workflow');
  await rm(workflowDir, { recursive: true, force: true });
  await mkdir(workflowDir, { recursive: true });
  for (const entry of validated) {
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
