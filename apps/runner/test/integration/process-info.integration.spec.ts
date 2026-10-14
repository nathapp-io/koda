import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { readProcessCommand, readProcessStart, reapNaxPids } from '../../src/executor/pid-registry';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

// Real `ps` checks (US-001 AC-10, AC-11). The unit run never spawns `ps` (nax#2520: EPERM in a sandboxed session on macOS),
// so these live in the integration suite. Run with `bun run test:integration`.

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const T0 = new Date('2026-10-01T00:00:00.000Z');
const entry = (pid: number, over: Partial<{ spawnedAt: string; workdir: string }> = {}) => JSON.stringify({ pid, spawnedAt: over.spawnedAt ?? '2026-10-01T00:00:05.000Z', workdir: over.workdir ?? '/repo' });

describe('readProcessCommand', () => {
  test('returns the full command line of a live process and null for none', async () => {
    const proc = Bun.spawn(['sh', '-c', 'sleep 30; true', 'koda-job-abc123'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await readProcessCommand(proc.pid)).toContain('koda-job-abc123');
      expect(await readProcessCommand(2 ** 22 + 12345)).toBeNull();
      expect(await readProcessCommand(0)).toBeNull();
    } finally {
      proc.kill();
    }
  });
  test('AC-10: the running test process has a non-empty command line', async () => {
    const command = await readProcessCommand(process.pid);
    expect(command).not.toBeNull();
    expect((command ?? '').length).toBeGreaterThan(0);
  });
  test('AC-11: a pid that does not exist has no command line, and a pid that has exited has none either', async () => {
    expect(await readProcessCommand(2 ** 22 + 12345)).toBeNull();
    const exited = Bun.spawn(['sh', '-c', 'true'], { stdout: 'ignore', stderr: 'ignore' });
    await exited.exited;
    expect(await readProcessCommand(exited.pid)).toBeNull();
  });
});

describe('readProcessStart (BUG-5a: TZ-independent)', () => {
  test('a live process start is parsed in UTC, not the runner host TZ', async () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York';                 // a UTC-4/5 host would shift an unzoned parse by hours
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const started = await readProcessStart(proc.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(Date.now() - (started as Date).getTime())).toBeLessThan(60_000);
    } finally {
      proc.kill();
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });
  test('an absent pid has no start time', async () => {
    expect(await readProcessStart(2 ** 22 + 12345)).toBeNull();
  });
  test('AC-11: a pid that has exited has no start time', async () => {
    const exited = Bun.spawn(['sh', '-c', 'true'], { stdout: 'ignore', stderr: 'ignore' });
    await exited.exited;
    expect(await readProcessStart(exited.pid)).toBeNull();
  });
  test('AC-10: the running test process starts at a Date not later than now', async () => {
    const started = await readProcessStart(process.pid);
    expect(started).toBeInstanceOf(Date);
    expect((started as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('reapNaxPids with real processes', () => {
  test('kills a registered child of this checkout, spares a recycled entry, and truncates the file', async () => {
    const repoDir = await tmp.make('repo');
    const mine = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    const recycled = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect((await readProcessStart(mine.pid))?.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await readProcessStart(2 ** 22 + 12345)).toBeNull();
      const now = new Date();
      const lines = [
        entry(mine.pid, { spawnedAt: now.toISOString(), workdir: repoDir }),
        entry(recycled.pid, { spawnedAt: new Date(now.getTime() - 3_600_000).toISOString(), workdir: repoDir }),
      ];
      await writeFile(join(repoDir, '.nax-pids'), `${lines.join('\n')}\n`);
      const killed = await reapNaxPids({ repoDir, since: new Date(now.getTime() - 3_700_000) });
      expect(killed).toEqual([mine.pid]);
      await waitFor(() => !isProcessAlive(mine.pid));
      expect(isProcessAlive(recycled.pid)).toBe(true);
      expect(await readFile(join(repoDir, '.nax-pids'), 'utf8')).toBe('');
    } finally {
      mine.kill();
      recycled.kill();
    }
  });
  test('no registry file is a no-op', async () => {
    expect(await reapNaxPids({ repoDir: await tmp.make('repo'), since: T0 })).toEqual([]);
  });
});
