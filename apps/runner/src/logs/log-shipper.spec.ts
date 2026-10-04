import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryLogger } from '../logger';
import { fakeLogServer } from '../../test/helpers/fake-log-server';
import { manualClock } from '../../test/helpers/manual-clock';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import { LogShipper, type LogShipperTuning } from './log-shipper';
import type { JobLogSources } from './types';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const shippers: LogShipper[] = [];
afterEach(async () => { await Promise.all(shippers.splice(0).map((s) => s.close())); });

function setup(over: { tuning?: Partial<LogShipperTuning>; random?: () => number } = {}) {
  const clock = manualClock();
  const server = fakeLogServer();
  const log = createMemoryLogger();
  const notes: Array<{ job: string; level: string; message: string }> = [];
  const shipper = new LogShipper({
    transport: server.transport, log, nowMs: clock.nowMs, sleep: clock.sleep, random: over.random ?? (() => 0),
    tuning: { chunkBytes: 64, maxInFlight: 2, putTimeoutMs: 30_000, backoffMaxMs: 30_000, ...over.tuning },
  });
  shippers.push(shipper);
  const register = (jobId: string, sources: JobLogSources) => shipper.register({
    jobId, leaseEpoch: 1, sources, lifecycle: (level, message) => { notes.push({ job: jobId, level, message }); },
  });
  return { clock, server, log, notes, shipper, register };
}

async function job(name: string, runLog = true): Promise<{ dir: string; sources: JobLogSources; runPath: string }> {
  const dir = await tmp.make(name);
  const outDir = join(dir, 'nax-out');
  return {
    dir,
    sources: { outDir, feature: 'f', stdoutPath: join(dir, 'nax.stdout'), stderrPath: join(dir, 'nax.stderr'), runLog },
    runPath: join(outDir, 'features', 'f', 'runs', 'log-1.jsonl'),
  };
}
const writeRun = async (path: string, text: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

describe('shipping while the job runs', () => {
  test('sends whole lines from offset 0 and holds a partial last line until it is finished', async () => {
    const t = setup();
    const j = await job('lines');
    await writeFile(j.sources.stdoutPath, 'one\ntw');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'one\n');
    await appendFile(j.sources.stdoutPath, 'o\n');
    t.shipper.wake('j1', 1);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'one\ntwo\n');
    expect(t.server.calls.every((c) => !c.final)).toBe(true);
  });
  test('a file larger than a chunk goes in chunk-sized pieces; an overlong line goes as a full window (R12)', async () => {
    const t = setup();
    const j = await job('long');
    const content = `${'x'.repeat(150)}\nshort\n`;
    await writeFile(j.sources.stderrPath, content);
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stderr') === content);
    expect(t.server.calls.filter((c) => c.stream === 'stderr').map((c) => c.text.length)).toEqual([64, 64, 29]);
  });
  test('resumes at the server size: a re-adopted stream starts at 0, the answer jumps it, nothing is stored twice (R3)', async () => {
    const t = setup();
    const j = await job('resume');
    await writeFile(j.sources.stdoutPath, 'a\nb\nc\n');
    t.server.seed('j1:1:stdout', 'a\nb\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\nb\nc\n');
    expect(t.server.calls.map((c) => c.offset)).toEqual([0, 4]);
  });
  test('the run log is found on a later wake and shipped from 0; a PLAN job never ships one (spec §2.4)', async () => {
    const t = setup();
    const run = await job('run');
    const plan = await job('plan', false);
    t.register('run', run.sources);
    t.register('plan', plan.sources);
    await Bun.sleep(30);                                            // the first search has come back empty
    expect(t.server.calls).toEqual([]);
    await writeRun(run.runPath, '{"msg":"a"}\n');
    await writeRun(plan.runPath, '{"msg":"p"}\n');
    t.shipper.wake('run', 1);
    t.shipper.wake('plan', 1);
    await waitFor(() => t.server.stored('run:1:run') === '{"msg":"a"}\n');
    await Bun.sleep(30);
    expect(t.server.calls.some((c) => c.key === 'plan:1:run')).toBe(false);
  });
  test('at most maxInFlight PUTs at once (R4)', async () => {
    const t = setup();
    const a = await job('a');
    const b = await job('b');
    for (const path of [a.sources.stdoutPath, a.sources.stderrPath, b.sources.stdoutPath]) await writeFile(path, 'x\n');
    t.server.overrides.push('hold', 'hold', 'hold');
    t.register('a', a.sources);
    t.register('b', b.sources);
    await waitFor(() => t.server.inFlight === 2);
    await Bun.sleep(30);
    expect(t.server.inFlight).toBe(2);
    t.server.release();
    await waitFor(() => t.server.calls.length === 3 && t.server.inFlight === 1);   // the third hold is registered
    t.server.release();
    await waitFor(() => ['a:1:stdout', 'a:1:stderr', 'b:1:stdout'].every((k) => t.server.stored(k) === 'x\n'));
    expect(t.server.maxInFlight).toBe(2);
  });
  test('round-robin: a chatty stream does not starve another job\'s stream (R4)', async () => {
    const t = setup({ tuning: { maxInFlight: 1 } });
    const chatty = await job('chatty');
    const quiet = await job('quiet');
    await writeFile(chatty.sources.stdoutPath, `${'c'.repeat(63)}\n`.repeat(5));   // five 64-byte chunks
    t.server.overrides.push('hold');
    t.register('chatty', chatty.sources);
    await waitFor(() => t.server.inFlight === 1);
    await writeFile(quiet.sources.stdoutPath, 'q\n');
    t.register('quiet', quiet.sources);
    t.server.release();
    await waitFor(() => t.server.stored('chatty:1:stdout').length === 320 && t.server.stored('quiet:1:stdout') === 'q\n');
    const order = t.server.calls.filter((c) => c.stream === 'stdout').map((c) => c.key);
    expect(order.indexOf('quiet:1:stdout')).toBeLessThan(order.lastIndexOf('chatty:1:stdout'));
    expect(order.indexOf('quiet:1:stdout')).toBeLessThanOrEqual(2);
  });
  test('wake returns at once while a PUT hangs: the watch tick never waits on the network (R4)', async () => {
    const t = setup();
    const j = await job('hang');
    await writeFile(j.sources.stdoutPath, 'x\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) t.shipper.wake('j1', 1);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('the answer table (spec §2.4, plan D323)', () => {
  test('offset jumps to the server size and continues from there', async () => {
    const t = setup();
    const j = await job('offset');
    await writeFile(j.sources.stdoutPath, 'a\nb\n');
    t.server.seed('j1:1:stdout', 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'offset', size: 2 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\nb\n');
    expect(t.server.calls[1].offset).toBe(2);
  });
  test('404 stops every stream of the job like 409 (the job is gone)', async () => {
    const t = setup();
    const j = await job('gone');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 404 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await writeFile(j.sources.stderrPath, 'e\n');
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    expect(await t.shipper.drain('j1', 1, 1_000)).toBe('drained');
  });
  test('an ack that does not move past a non-empty PUT backs off instead of re-sending at once', async () => {
    const t = setup({ random: () => 0.5 });
    const j = await job('stuck');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'appended', size: 0 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    t.clock.advance(500);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
  });
  test('an ack below what the server already acked is diverged, never a rewind (S2a slice 2 D350)', async () => {
    const t = setup();
    const j = await job('rewind');
    await writeFile(j.sources.stdoutPath, 'a\nb\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\nb\n');
    t.server.overrides.push({ status: 200, outcome: 'appended', size: 1 });
    await appendFile(j.sources.stdoutPath, 'c\n');
    t.shipper.wake('j1', 1);
    await waitFor(() => t.notes.length === 1);
    expect(t.notes[0]).toMatchObject({ level: 'warn' });
    expect(t.notes[0].message).toContain('less of the stdout log');
    await appendFile(j.sources.stdoutPath, 'd\n');
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls.filter((c) => c.stream === 'stdout').map((c) => c.offset)).toEqual([0, 4]);
  });
  test('offset or duplicate with a size above the local file: diverged, lifecycle warn, no further PUT (R6)', async () => {
    for (const outcome of ['offset', 'duplicate'] as const) {
      const t = setup();
      const j = await job(`ahead-${outcome}`);
      await writeFile(j.sources.stdoutPath, 'a\n');
      t.server.overrides.push({ status: 200, outcome, size: 50 });
      t.register('j1', j.sources);
      await waitFor(() => t.notes.length === 1);
      expect(t.notes[0]).toMatchObject({ level: 'warn' });
      expect(t.notes[0].message).toContain('stdout');
      t.shipper.wake('j1', 1);
      await Bun.sleep(30);
      expect(t.server.calls.filter((c) => c.stream === 'stdout')).toHaveLength(1);
    }
  });
  test('complete: the stream is done and later wakes send nothing', async () => {
    const t = setup();
    const j = await job('complete');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'complete', size: 2 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await appendFile(j.sources.stdoutPath, 'b\n');
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
  });
  test('stream_cap: that stream stops with a lifecycle warn; the job\'s other stream goes on', async () => {
    const t = setup();
    const j = await job('cap');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'stream_cap', size: 1 });
    t.register('j1', j.sources);
    await waitFor(() => t.notes.length === 1);
    expect(t.notes[0]).toMatchObject({ level: 'warn' });
    expect(t.notes[0].message).toContain('size cap');
    await writeFile(j.sources.stderrPath, 'e\n');
    t.shipper.wake('j1', 1);
    await waitFor(() => t.server.stored('j1:1:stderr') === 'e\n');
  });
  test('rate_limited pauses every stream for retryAfterMs, then shipping resumes', async () => {
    const t = setup();
    const a = await job('ra');
    const b = await job('rb');
    await writeFile(a.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 5_000 });
    t.register('a', a.sources);
    await waitFor(() => t.server.calls.length === 1);
    await writeFile(b.sources.stdoutPath, 'b\n');
    t.register('b', b.sources);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    t.clock.advance(5_000);
    await waitFor(() => t.server.stored('a:1:stdout') === 'a\n' && t.server.stored('b:1:stdout') === 'b\n');
  });
  test('409 and 401 stop every stream of that job, without a lifecycle event; another job is untouched', async () => {
    for (const status of [409, 401]) {
      const t = setup();
      const a = await job(`stop-a-${status}`);
      const b = await job(`stop-b-${status}`);
      await writeFile(a.sources.stdoutPath, 'a\n');
      t.server.overrides.push({ status });
      t.register('a', a.sources);
      await waitFor(() => t.server.calls.length === 1);
      await writeFile(a.sources.stderrPath, 'e\n');
      t.shipper.wake('a', 1);
      await writeFile(b.sources.stdoutPath, 'b\n');
      t.register('b', b.sources);
      await waitFor(() => t.server.stored('b:1:stdout') === 'b\n');
      expect(t.server.calls.some((c) => c.key === 'a:1:stderr')).toBe(false);
      expect(t.notes).toEqual([]);
    }
  });
  test('400 and 413 stop only that stream, with a lifecycle error', async () => {
    for (const status of [400, 413]) {
      const t = setup();
      const j = await job(`bad-${status}`);
      await writeFile(j.sources.stdoutPath, 'a\n');
      t.server.overrides.push({ status });
      t.register('j1', j.sources);
      await waitFor(() => t.notes.length === 1);
      expect(t.notes[0]).toMatchObject({ level: 'error' });
      expect(t.notes[0].message).toContain(`HTTP ${status}`);
      await writeFile(j.sources.stderrPath, 'e\n');
      t.shipper.wake('j1', 1);
      await waitFor(() => t.server.stored('j1:1:stderr') === 'e\n');
    }
  });
  test('422, 507 and a network failure back off with jitter, then retry the same offset', async () => {
    const t = setup({ random: () => 0.5 });
    const j = await job('backoff');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 422 }, { status: 507 }, 'network');
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    t.clock.advance(500);                                           // attempt 0: 0.5 * 1 s
    await waitFor(() => t.server.calls.length === 2);
    t.clock.advance(1_000);                                         // attempt 1: 0.5 * 2 s
    await waitFor(() => t.server.calls.length === 3);
    t.clock.advance(2_000);                                         // attempt 2: 0.5 * 4 s
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
    expect(t.server.calls.map((c) => c.offset)).toEqual([0, 0, 0, 0]);
    expect(t.log.lines.filter((l) => l.message === 'log upload failed; backing off')).toHaveLength(1);
  });
  test('a PUT that hangs is aborted after putTimeoutMs and retried', async () => {
    const t = setup();
    const j = await job('timeout');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    t.clock.advance(30_000);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
    expect(t.server.calls).toHaveLength(2);
  });
  test('a file that shrinks below the acked offset is diverged with a lifecycle warn and never rewound (R6)', async () => {
    const t = setup();
    const j = await job('shrink');
    await writeFile(j.sources.stdoutPath, 'aaaa\nbbbb\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'aaaa\nbbbb\n');
    await truncate(j.sources.stdoutPath, 3);
    t.shipper.wake('j1', 1);
    await waitFor(() => t.notes.length === 1);
    expect(t.notes[0].message).toContain('shrank');
    expect(t.server.calls.every((c) => c.offset !== 0 || c === t.server.calls[0])).toBe(true);
  });
});

describe('drain, stop and close (spec §2.4 R5)', () => {
  test('drain ships to the file end without a newline cut, ends with final=1, and resolves drained', async () => {
    const t = setup();
    const j = await job('drain');
    await writeFile(j.sources.stdoutPath, 'a\nno newline');
    await writeFile(j.sources.stderrPath, '');
    await writeRun(j.runPath, '{"m":1}\n');
    t.register('j1', j.sources);
    expect(await t.shipper.drain('j1', 1, 120_000)).toBe('drained');
    expect(t.server.stored('j1:1:stdout')).toBe('a\nno newline');
    for (const stream of ['stdout', 'stderr', 'run']) expect(t.server.isComplete(`j1:1:${stream}`)).toBe(true);
    expect(t.server.calls.filter((c) => c.final)).toHaveLength(3);
    expect(t.server.calls.find((c) => c.key === 'j1:1:stderr')).toMatchObject({ offset: 0, text: '', final: true });
  });
  test('a final PUT answered with a plain ack backs off instead of re-sending final at once (S2a slice 2 D351)', async () => {
    const t = setup({ random: () => 0.5 });
    const j = await job('final-ack');
    await writeFile(j.sources.stdoutPath, 'a\n');                   // only stdout exists: the override is its final PUT
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'duplicate', size: 2 });
    const drained = t.shipper.drain('j1', 1, 120_000);
    await waitFor(() => t.server.calls.some((c) => c.stream === 'stdout' && c.final));
    await Bun.sleep(30);
    expect(t.server.calls.filter((c) => c.stream === 'stdout' && c.final)).toHaveLength(1);
    t.clock.advance(500);
    expect(await drained).toBe('drained');
    expect(t.server.isComplete('j1:1:stdout')).toBe(true);
    expect(t.server.calls.filter((c) => c.stream === 'stdout' && c.final)).toHaveLength(2);
  });
  test('drain during an in-flight PUT: final goes only after that window is acked and the rest is read (Review focus 1)', async () => {
    const t = setup();
    const j = await job('inflight');
    await writeFile(j.sources.stdoutPath, 'a\ntail');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    t.server.release();
    expect(await drained).toBe('drained');
    expect(t.server.stored('j1:1:stdout')).toBe('a\ntail');
    const stdout = t.server.calls.filter((c) => c.stream === 'stdout');
    expect(stdout.map((c) => [c.offset, c.text, c.final])).toEqual([[0, 'a\n', false], [2, 'tail', true]]);
  });
  test('a stream whose file never appeared is done at drain with no PUT; a run log found only by the drain is shipped (Review focus 3)', async () => {
    const t = setup();
    const j = await job('late');
    await writeFile(j.sources.stdoutPath, 'o\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'o\n');
    await writeRun(j.runPath, '{"late":true}\n');
    expect(await t.shipper.drain('j1', 1, 120_000)).toBe('drained');
    expect(t.server.calls.some((c) => c.stream === 'stderr')).toBe(false);
    expect(t.server.stored('j1:1:run')).toBe('{"late":true}\n');
    expect(t.server.isComplete('j1:1:run')).toBe(true);
  });
  test('drain times out: in-flight PUTs are aborted, nothing more is sent, and it resolves timeout', async () => {
    const t = setup();
    const j = await job('drain-timeout');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    t.clock.advance(120_000);
    expect(await drained).toBe('timeout');
    await waitFor(() => t.server.inFlight === 0);
    const sent = t.server.calls.length;
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(sent);
  });
  test('stopJob mid-drain aborts the PUT, resolves stopped, and writes no lifecycle event (Review focus 4)', async () => {
    const t = setup();
    const j = await job('stop');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    t.shipper.stopJob('j1', 1);
    expect(await drained).toBe('stopped');
    await waitFor(() => t.server.inFlight === 0);
    await Bun.sleep(30);
    expect(t.notes).toEqual([]);
    expect(t.server.calls).toHaveLength(1);
  });
  test('a stream backing off is bounded by the drain deadline', async () => {
    const t = setup({ random: () => 0.999 });
    const j = await job('drain-backoff');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    const drained = t.shipper.drain('j1', 1, 1_500);
    t.clock.advance(1_500);
    expect(await drained).toBe('timeout');
  });
  test('a lifecycle callback that throws still settles the stream, so the drain finishes', async () => {
    const t = setup();
    const j = await job('throwing');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'offset', size: 99 });
    t.shipper.register({ jobId: 'j1', leaseEpoch: 1, sources: j.sources, lifecycle: () => { throw new Error('journal closed'); } });
    await waitFor(() => t.server.calls.length === 1);
    expect(await t.shipper.drain('j1', 1, 120_000)).toBe('drained');
    expect(t.log.lines.some((l) => l.message === 'log lifecycle callback failed')).toBe(true);
  });
  test('drain of an unknown or already finished job resolves drained at once', async () => {
    const t = setup();
    expect(await t.shipper.drain('nobody', 1, 1_000)).toBe('drained');
  });
  test('close resolves a pending drain with stopped and the workers end', async () => {
    const t = setup();
    const j = await job('close');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    await t.shipper.close();
    expect(await drained).toBe('stopped');
    t.register('j2', j.sources);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
  });
});
