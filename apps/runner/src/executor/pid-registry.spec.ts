import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import { isProcessAlive } from './nax-process';
import { parsePidEntries, readProcessCommand, readProcessStart, reapNaxPids, selectReapable } from './pid-registry';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const T0 = new Date('2026-10-01T00:00:00.000Z');
const entry = (pid: number, over: Partial<{ spawnedAt: string; workdir: string }> = {}) => JSON.stringify({ pid, spawnedAt: over.spawnedAt ?? '2026-10-01T00:00:05.000Z', workdir: over.workdir ?? '/repo' });

describe('parsePidEntries (nax writes JSON lines)', () => {
  test('skips blank and damaged lines', () => {
    const text = `${entry(11)}\n\nnot json\n{"pid":"x"}\n${entry(12)}\n`;
    expect(parsePidEntries(text).map((e) => e.pid)).toEqual([11, 12]);
  });
});

describe('selectReapable (D37: pids recycle)', () => {
  const started = (map: Record<number, Date | null>) => async (pid: number) => map[pid] ?? null;
  test('keeps only entries of this checkout, registered since the spawn, whose process started before it registered', async () => {
    const entries = parsePidEntries([
      entry(21),                                                        // good
      entry(22, { workdir: '/other' }),                                 // another checkout
      entry(23, { spawnedAt: '2026-09-30T00:00:00.000Z' }),             // registered before this job
      entry(24),                                                        // recycled: process started after registration
      entry(25),                                                        // process gone
      entry(1), entry(0),                                               // reserved pids
      entry(999),                                                       // the daemon itself
    ].join('\n'));
    const startedAt = started({
      21: new Date('2026-10-01T00:00:04.000Z'), 22: new Date('2026-10-01T00:00:04.000Z'), 23: new Date('2026-09-30T00:00:00.000Z'),
      24: new Date('2026-10-01T02:00:00.000Z'), 25: null, 999: new Date('2026-10-01T00:00:04.000Z'),
    });
    expect(await selectReapable(entries, { repoDir: '/repo', since: T0, startedAt, selfPid: 999 })).toEqual([21]);
  });
  test('BUG-5: a real nax registered within 5s of its start is picked (lstart slack covers normal races)', async () => {
    const entries = parsePidEntries([
      entry(31, { spawnedAt: '2026-10-01T00:00:05.000Z' }),   // registered at 5s
    ].join('\n'));
    const startedAt = started({ 31: new Date('2026-10-01T00:00:07.100Z') });   // process started 2.1s AFTER registration
    expect(await selectReapable(entries, { repoDir: '/repo', since: T0, startedAt })).toEqual([31]);
  });
  test('a recycled pid whose process started far after registration (well past the slack) is still skipped', async () => {
    const entries = parsePidEntries([
      entry(32, { spawnedAt: '2026-10-01T00:00:05.000Z' }),
    ].join('\n'));
    const startedAt = started({ 32: new Date('2026-10-01T00:00:30.000Z') });   // 25s after registration
    expect(await selectReapable(entries, { repoDir: '/repo', since: T0, startedAt })).toEqual([]);
  });
});

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
