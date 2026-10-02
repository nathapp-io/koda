import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEventPayload, SnapshotEventPayload } from '@nathapp/fleet-protocol';
import type { SnapshotStory } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { FileTail } from './file-tail';
import { LogBudget, chunkText } from './log-budget';
import { findCostRunId, findRunLog, runLogId } from './run-log';
import { Watcher, type WatcherOptions, type WatcherSink } from './watcher';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

let base: string;
let snaps: SnapshotEventPayload[];
let logs: LogEventPayload[];
let notes: Array<{ level: string; message: string }>;
let ids: Array<{ naxRunId: string; logPath: string | null }>;
let clock = 0;
const sink: WatcherSink = {
  snapshot: (p) => { snaps.push(p); },
  lifecycle: (level, message) => { notes.push({ level, message }); },
  logLine: (p) => { logs.push(p); },
};
const options = (over: Partial<WatcherOptions> = {}): WatcherOptions => ({
  outDir: join(base, 'out'), feature: 'feat', stdoutPath: join(base, 'nax.stdout'), stderrPath: join(base, 'nax.stderr'),
  startAtEnd: false, nowMs: () => clock, onRunIds: (i) => { ids.push(i); }, ...over,
});
const writeStatus = (over: Record<string, unknown> = {}) => writeFile(join(base, 'out', 'status.json'), JSON.stringify({
  version: 1, run: { id: 'run-1', status: 'running' }, progress: { total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 },
  cost: { spent: 0.5 }, current: { storyId: 'US-002', phase: 'implement' }, lastHeartbeat: '2026-10-01T00:00:00.000Z', ...over,
}));
const runsDir = () => join(base, 'out', 'features', 'feat', 'runs');
const prdPath = () => join(base, 'repo', '.nax', 'features', 'feat', 'prd.json');
const writePrd = async (stories: Array<Record<string, unknown>> | string) => {
  await mkdir(join(base, 'repo', '.nax', 'features', 'feat'), { recursive: true });
  await writeFile(prdPath(), typeof stories === 'string' ? stories : JSON.stringify({ feature: 'feat', userStories: stories }));
};
const story = (over: Partial<SnapshotStory> = {}): SnapshotStory => ({ id: 'US-001', title: 'first', status: 'pending', attempts: 0, dependsOn: [], ...over });

beforeEach(async () => {
  base = await tmp.make('watch');
  await mkdir(join(base, 'out'), { recursive: true });
  snaps = []; logs = []; notes = []; ids = []; clock = 0;
});

describe('snapshots', () => {
  test('emits on the first read, again only when the mapped payload changes, and reports run ids once', async () => {
    const w = new Watcher(sink, options());
    await writeStatus();
    await w.tick();
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ naxRunId: 'run-1', currentStoryId: 'US-002', costSpentUsd: '0.5000' });
    await writeStatus({ progress: { total: 3, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 1 } });
    await w.tick();
    expect(snaps).toHaveLength(2);
    expect(ids).toEqual([{ naxRunId: 'run-1', logPath: null }]);
  });
  test('a missing status.json (PLAN, or not started yet) emits nothing and warns nothing', async () => {
    const w = new Watcher(sink, options());
    for (let i = 0; i < 8; i += 1) await w.tick();
    expect(snaps).toEqual([]);
    expect(notes).toEqual([]);
  });
  test('five unreadable reads in a row warn once; a good read recovers and emits', async () => {
    const w = new Watcher(sink, options());
    await writeFile(join(base, 'out', 'status.json'), '{"run":');
    for (let i = 0; i < 7; i += 1) await w.tick();
    expect(notes).toEqual([{ level: 'warn', message: 'status.json unreadable 5 times in a row' }]);
    await writeStatus();
    await w.tick();
    expect(snaps).toHaveLength(1);
    await writeFile(join(base, 'out', 'status.json'), '{"run":');
    for (let i = 0; i < 5; i += 1) await w.tick();
    expect(notes).toHaveLength(2); // a new streak warns again
  });
  test('the run log and cost ledger ids appear in the snapshot; latest.jsonl is never the run log', async () => {
    await mkdir(runsDir(), { recursive: true });
    await mkdir(join(base, 'out', 'cost'), { recursive: true });
    await writeFile(join(runsDir(), 'log-7.jsonl'), '');
    await symlink('log-7.jsonl', join(runsDir(), 'latest.jsonl'));
    await writeFile(join(base, 'out', 'cost', 'cost-7.jsonl'), '');
    await writeStatus();
    await new Watcher(sink, options()).tick();
    expect(snaps[0]).toMatchObject({ naxLogRunId: 'log-7', naxCostRunId: 'cost-7' });
    expect(ids[0].logPath).toBe(join(runsDir(), 'log-7.jsonl'));
  });
});

describe('run log discovery', () => {
  test('none, one, and several (newest wins)', async () => {
    expect(await findRunLog(join(base, 'out'), 'feat')).toBeNull();
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'a.jsonl'), '');
    expect(await findRunLog(join(base, 'out'), 'feat')).toBe(join(runsDir(), 'a.jsonl'));
    await Bun.sleep(15);
    await writeFile(join(runsDir(), 'b.jsonl'), '');
    expect(await findRunLog(join(base, 'out'), 'feat')).toBe(join(runsDir(), 'b.jsonl'));
    expect(runLogId(join(runsDir(), 'b.jsonl'))).toBe('b');
    expect(await findCostRunId(join(base, 'out'))).toBeNull();
  });
});

describe('log tails', () => {
  test('run log, stdout and stderr become log events on their streams, whole lines only until the final flush', async () => {
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'log-1.jsonl'), '{"msg":"a"}\n{"msg":"par');
    await writeFile(join(base, 'nax.stdout'), 'hello out\n');
    await writeFile(join(base, 'nax.stderr'), 'oops err\n');
    const w = new Watcher(sink, options());
    await w.tick();
    expect(logs).toEqual(expect.arrayContaining([
      { stream: 'run', text: '{"msg":"a"}\n' }, { stream: 'stdout', text: 'hello out\n' }, { stream: 'stderr', text: 'oops err\n' },
    ]));
    expect(logs.filter((l) => l.stream === 'run')).toHaveLength(1);
    await appendFile(join(runsDir(), 'log-1.jsonl'), 'tial"}\n');
    await w.tick();
    expect(logs.filter((l) => l.stream === 'run').map((l) => l.text)).toEqual(['{"msg":"a"}\n', '{"msg":"partial"}\n']);
    await appendFile(join(base, 'nax.stdout'), 'no newline at exit');
    await w.tick();
    expect(logs.filter((l) => l.stream === 'stdout')).toHaveLength(1);
    await w.tick(true);
    expect(logs.filter((l) => l.stream === 'stdout').map((l) => l.text)).toEqual(['hello out\n', 'no newline at exit']);
  });
  test('startAtEnd (readopt, D34) skips what is on disk, tails what is appended, and still snapshots', async () => {
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'log-1.jsonl'), 'old\n');
    await writeFile(join(base, 'nax.stdout'), 'old out\n');
    await writeStatus();
    const w = new Watcher(sink, options({ startAtEnd: true }));
    await w.tick();
    expect(logs).toEqual([]);
    expect(snaps).toHaveLength(1);
    await appendFile(join(runsDir(), 'log-1.jsonl'), 'new\n');
    await appendFile(join(base, 'nax.stdout'), 'new out\n');
    await w.tick();
    expect(logs.map((l) => l.text).sort()).toEqual(['new\n', 'new out\n']);
  });
  test('a file that shrinks is read again from the start', async () => {
    await writeFile(join(base, 'nax.stdout'), 'a-long-first-line\n');
    const w = new Watcher(sink, options());
    await w.tick();
    await writeFile(join(base, 'nax.stdout'), 'b\n');
    await w.tick();
    expect(logs.map((l) => l.text)).toEqual(['a-long-first-line\n', 'b\n']);
  });
});

describe('the log rate cap (D45)', () => {
  test('at most 60 log events a minute; the excess is counted into the next snapshot once', async () => {
    await writeStatus();
    const w = new Watcher(sink, options());
    await w.tick();
    for (let i = 0; i < 100; i += 1) {
      await appendFile(join(base, 'nax.stdout'), `line ${i}\n`);
      await w.tick();
    }
    expect(logs).toHaveLength(60);
    await writeStatus({ progress: { total: 3, passed: 3, failed: 0, paused: 0, blocked: 0, pending: 0 } });
    await w.tick();
    expect(snaps.at(-1)).toMatchObject({ droppedLogs: 40 });
    await writeStatus({ cost: { spent: 9 } });
    await w.tick();
    expect(snaps.at(-1)).not.toHaveProperty('droppedLogs');
  });
  test('the window slides: a minute later logging resumes', async () => {
    const budget = new LogBudget(() => clock, 2);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    expect(budget.dropped).toBe(1);
    clock = 61_000;
    expect(budget.take()).toBe(true);
    expect(budget.takeDropped()).toBe(1);
    expect(budget.takeDropped()).toBe(0);
  });
});

describe('chunkText', () => {
  test('keeps every chunk under 8000 raw and 15000 escaped bytes, splitting on code points', () => {
    const control = chunkText('\u0001'.repeat(9_000));
    expect(control.length).toBeGreaterThan(1);
    for (const c of control) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(8_000);
      expect(Buffer.byteLength(JSON.stringify({ stream: 'run', text: c }), 'utf8')).toBeLessThanOrEqual(16_384);
    }
    expect(control.join('')).toBe('\u0001'.repeat(9_000));
    const wide = chunkText('\u{1F600}'.repeat(4_000)); // 4-byte characters
    for (const c of wide) {
      expect(c).toMatch(/^(\u{1F600})+$/u);
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(8_000);
    }
    expect(wide.join('')).toBe('\u{1F600}'.repeat(4_000));
  });
  test('short and empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('abc\n')).toEqual(['abc\n']);
  });
});

describe('FileTail', () => {
  test('a missing file reads as empty; fromEnd starts after the current content', async () => {
    const path = join(base, 't.log');
    expect(await FileTail.fromStart(path).readNew()).toBe('');
    await writeFile(path, 'x\n');
    const tail = await FileTail.fromEnd(path);
    expect(await tail.readNew()).toBe('');
    await appendFile(path, 'y\n');
    expect(await tail.readNew()).toBe('y\n');
    await truncate(path, 0);
    await appendFile(path, 'z\n');
    expect(await tail.readNew()).toBe('z\n');
  });
});

describe('story list (S1b §1.2)', () => {
  test('sends the list with the first snapshot, not again while unchanged, and again on a PRD-only change (Review focus 4)', async () => {
    const w = new Watcher(sink, options({ repoDir: join(base, 'repo') }));
    await writeStatus();
    await writePrd([{ id: 'US-001', title: 'first', status: 'pending' }]);
    await w.tick();
    expect(snaps[0]).toMatchObject({ naxRunId: 'run-1', stories: [story()], storiesTruncated: false });

    await writeStatus({ progress: { total: 3, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 1 } });
    await w.tick();
    expect(snaps).toHaveLength(2);
    expect(snaps[1]).not.toHaveProperty('stories');
    expect(snaps[1]).not.toHaveProperty('storiesTruncated');

    await w.tick();
    expect(snaps).toHaveLength(2);

    await writePrd([{ id: 'US-001', title: 'first', status: 'passed', attempts: 1 }]);
    await w.tick();
    expect(snaps).toHaveLength(3);
    expect(snaps[2]).toMatchObject({ stories: [story({ status: 'passed', attempts: 1 })], storiesTruncated: false });
  });

  test('an unreadable PRD omits the list without an extra snapshot; the next good read sends it (Review focus 2)', async () => {
    const w = new Watcher(sink, options({ repoDir: join(base, 'repo') }));
    await writeStatus();
    await writePrd('{"userSto');
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).not.toHaveProperty('stories');
    await w.tick();
    expect(snaps).toHaveLength(1);
    await writePrd([{ id: 'US-001', title: 'first' }]);
    await w.tick();
    expect(snaps).toHaveLength(2);
    expect(snaps[1]).toMatchObject({ stories: [story()] });
    await writePrd('{"userSto');
    await w.tick();
    expect(snaps).toHaveLength(2);
  });

  test('without repoDir (a PLAN job, D146) no list is ever read', async () => {
    const w = new Watcher(sink, options());
    await writeStatus();
    await writePrd([{ id: 'US-001' }]);
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).not.toHaveProperty('stories');
  });

  test('no status.json yet: no snapshot, even with a PRD', async () => {
    const w = new Watcher(sink, options({ repoDir: join(base, 'repo') }));
    await writePrd([{ id: 'US-001' }]);
    await w.tick();
    expect(snaps).toEqual([]);
  });
});
