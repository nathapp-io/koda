import { errorMessage } from '../errors';
import type { JobExecutor } from '../executor/job-executor';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';

/**
 * D65: SIGKILL the job's whole process group, but only while the journaled pid is still this job's nax (its argv carries
 * `koda-job-<jobId>`). A recycled pid is never signalled. Used by abandon, a runner error and READOPT rejection.
 */
export async function killIfOurs(executor: JobExecutor, row: JobRow, log: Logger): Promise<boolean> {
  if (row.pid === null || row.pgid === null) return false;
  try {
    if (!(await executor.matchesProcess(row))) return false;
    executor.kill(row.pgid, 'SIGKILL');
    return true;
  } catch (error) {
    log.warn('kill of the job process failed', { jobId: row.jobId, error: errorMessage(error) });
    return false;
  }
}
