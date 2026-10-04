import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';
import type { SnapshotStory } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { findCostRunId, findRunLog, runLogId } from './run-log';
import { Watcher, type WatcherOptions, type WatcherSink } from './watcher';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

let base: string;
let snaps: SnapshotEventPayload[];
let notes: Array<{ level: string; message: string }>;
let ids: Array<{ naxRunId: string; logPath: string | null }>;
const sink: WatcherSink = {
  snapshot: (p) => { snaps.push(p); },
  lifecycle: (level, message) => { notes.push({ level, message }); },
};
const options = (over: Partial<WatcherOptions> = {}): WatcherOptions => ({
  outDir: join(base, 'out'), feature: 'feat', onRunIds: (i) => { ids.push(i); }, ...over,
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
  snaps = []; notes = []; ids = [];
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

describe('logs are not the watcher\'s job (S2a plan D320)', () => {
  test('log files growing changes nothing: no new snapshot, and the run log is only used for its id', async () => {
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'log-1.jsonl'), '{"msg":"a"}\n');
    await writeFile(join(base, 'nax.stdout'), 'out\n');
    await writeStatus();
    const w = new Watcher(sink, options());
    await w.tick();
    await appendFile(join(runsDir(), 'log-1.jsonl'), '{"msg":"b"}\n');
    await appendFile(join(base, 'nax.stdout'), 'more\n');
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ naxLogRunId: 'log-1' });
    expect(ids).toEqual([{ naxRunId: 'run-1', logPath: join(runsDir(), 'log-1.jsonl') }]);
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
