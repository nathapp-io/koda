import { errorMessage } from '../errors';
import type { JobExecutor } from '../executor/job-executor';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';

/**
 * D65: SIGKILL the job's whole process group, but only while the journaled pid is still this job's nax (its argv carries
 * `koda-job-<jobId>`). A recycled pid is never signalled. Used by abandon, a runner error and READOPT rejection.
 *
 * @design SEC-2: the boolean return was discarded by every caller and hid the "deliberately not signalled" branch
 * (matchesProcess=false) from any future SIGTERM→SIGKILL escalation. The intent is now expressed as a `void` so a
 * caller that wants the audit trail must log it from the matchesProcess path.
 */
export async function killIfOurs(executor: JobExecutor, row: JobRow, log: Logger): Promise<void> {
  if (row.pid === null || row.pgid === null) return;
  try {
    if (!(await executor.matchesProcess(row))) return;
    executor.kill(row.pgid, 'SIGKILL');
  } catch (error) {
    log.warn('kill of the job process failed', { jobId: row.jobId, error: errorMessage(error) });
  }
}
