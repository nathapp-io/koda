import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { AGENT_TASK_FILE, removeAgentTask, writeAgentTask } from './agent-task-file';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('agent task file (fleet-agent-job US-008)', () => {
  test('AC-3: writes agent-task.md in the job dir with exactly the task text, mode 0600, and returns its path', async () => {
    const jobDir = await tmp.make('agent-task');
    const path = await writeAgentTask(jobDir, 'Review the spec');
    expect(path).toBe(join(jobDir, AGENT_TASK_FILE));
    expect(AGENT_TASK_FILE).toBe('agent-task.md');
    expect(await readFile(path, 'utf8')).toBe('Review the spec');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('a skill-invocation task is written verbatim, so nax expands /spec-review itself', async () => {
    const jobDir = await tmp.make('agent-skill');
    const task = '/spec-review\n\nFeature: flow-a\n';
    const path = await writeAgentTask(jobDir, task);
    expect(await readFile(path, 'utf8')).toBe(task);
  });

  test('a second write replaces the first, and the removal is idempotent', async () => {
    const jobDir = await tmp.make('agent-rewrite');
    const path = await writeAgentTask(jobDir, 'first');
    await writeAgentTask(jobDir, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
    await removeAgentTask(jobDir);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await removeAgentTask(jobDir);
  });

  test('a write into a missing job dir rejects instead of creating one', async () => {
    const base = await tmp.make('agent-missing');
    const jobDir = join(base, 'absent');
    await expect(writeAgentTask(jobDir, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(jobDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a directory in the file\'s place makes the write reject (the spawn-failure path)', async () => {
    const jobDir = await tmp.make('agent-dir');
    await mkdir(join(jobDir, AGENT_TASK_FILE), { recursive: true });
    await expect(writeAgentTask(jobDir, 'x')).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
