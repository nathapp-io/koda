import { mkdir } from 'node:fs/promises';
import type { Journal } from '../../src/journal/journal';
import type { ThreadJobRun } from '../../src/thread/thread-job-run';
import { waitFor } from './wait';

interface ThreadRunContext {
  run: ThreadJobRun;
  journal: Journal;
  jobDir: string;
}

/**
 * Starts a thread run and waits until it takes commands. The row goes RUNNING before `openStream` awaits its way to
 * the writer, and commands answer `session_not_ready` until it has (#303: a fixed sleep lost that race on CI). An
 * empty THREAD_INPUT probes the same check `command` makes without starting a turn: once ready it is `invalid payload`.
 */
export async function startThreadRun(context: ThreadRunContext, jobId: string, leaseEpoch: number): Promise<{ started: Promise<void> }> {
  await mkdir(context.jobDir, { recursive: true });
  const started = context.run.start('prepare');
  await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING', {
    timeoutMs: 5_000, intervalMs: 5, message: 'thread run never reached RUNNING',
  });
  await waitFor(async () => (await context.run.command('THREAD_INPUT', {})).detail !== 'session_not_ready', {
    timeoutMs: 5_000, intervalMs: 5, message: 'thread run never opened its stream',
  });
  return { started };
}
