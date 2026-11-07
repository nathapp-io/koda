import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * fleet-agent-job US-008: the task of an AGENT job travels on a file, never in argv — it is up to 16 KiB, would be
 * visible in the process list, and could meet the argv limit. nax reads `--task-file` at startup; a task starting
 * with `/<name>` is expanded by nax as a skill invocation, which F3 relies on for `/spec-review`.
 */
export const AGENT_TASK_FILE = 'agent-task.md';

/**
 * The task in `<jobDir>/agent-task.md`, created mode 0600 by the write itself. An attempt file: the attempt wipe
 * deletes a previous attempt's, and `cleanup` deletes this one. The job dir exists by then (`prepare` makes it), so a
 * missing one is an error, not something to create.
 */
export async function writeAgentTask(jobDir: string, task: string): Promise<string> {
  const path = join(jobDir, AGENT_TASK_FILE);
  await writeFile(path, task, { mode: 0o600 });
  return path;
}

/** Removes a leftover: at job cleanup, and in the attempt wipe before a retry reuses the dir. */
export async function removeAgentTask(jobDir: string): Promise<void> {
  await rm(join(jobDir, AGENT_TASK_FILE), { force: true });
}
