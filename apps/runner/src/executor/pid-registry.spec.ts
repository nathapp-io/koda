import { describe, expect, test } from 'bun:test';
import { PS_PROCESS_INFO, parsePidEntries, readProcessCommand, readProcessStart, selectReapable } from './pid-registry';

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

describe('PS_PROCESS_INFO (US-001 AC-9)', () => {
  test('AC-9: PS_PROCESS_INFO.start is readProcessStart and PS_PROCESS_INFO.command is readProcessCommand', () => {
    expect(PS_PROCESS_INFO.start).toBe(readProcessStart);
    expect(PS_PROCESS_INFO.command).toBe(readProcessCommand);
  });
});
