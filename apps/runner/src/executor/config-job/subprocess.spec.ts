import { describe, expect, test } from 'bun:test';
import { isProcessAlive } from '../nax-process';
import { waitFor } from '../../../test/helpers/wait';
import { trackedRun, type TrackedRunOptions } from './subprocess';
import { DeadlineError, StoppedError, checkpoint, raiseIfInterrupted, remainingMs } from './types';

const opts = (over: Partial<TrackedRunOptions> = {}) => {
  const seen: Array<{ pid: number; pgid: number } | null> = [];
  const options: TrackedRunOptions = {
    cwd: process.cwd(), env: process.env, deadlineMs: Date.now() + 30_000, nowMs: () => Date.now(), isStopped: () => false,
    onProcess: (proc) => { seen.push(proc); }, ...over,
  };
  return { options, seen };
};

describe('trackedRun (D484)', () => {
  test('captures exit code and both streams, and reports the process group then null', async () => {
    const { options, seen } = opts();
    const r = await trackedRun(['sh', '-c', 'echo out; echo err >&2; exit 3'], options);
    expect(r).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false, stopped: false });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.pid).toBeGreaterThan(1);
    expect(seen[0]?.pgid).toBe(seen[0]?.pid);
    expect(seen[1]).toBeNull();
  });
  test('a stop kills the whole group, grandchildren included', async () => {
    let stop = false;
    const { options } = opts({ isStopped: () => stop });
    setTimeout(() => { stop = true; }, 300);
    const started = Date.now();
    const r = await trackedRun(['sh', '-c', 'sleep 30 & echo $!; wait'], options);
    expect(r.stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(r.stdout.trim());
    await waitFor(() => !isProcessAlive(grandchild), { timeoutMs: 3_000 });
  });
  test('a stop whose SIGTERM came from outside ends the call as stopped even when it beat the watcher poll', async () => {
    let stop = false;
    let pgid: number | null = null;
    const { options } = opts({ isStopped: () => stop, onProcess: (proc) => { pgid = proc?.pgid ?? null; } });
    // The supervisor's CANCEL kills the group between two watcher polls: the child dies of the signal, not of the watcher.
    setTimeout(() => {
      stop = true;
      if (pgid !== null) process.kill(-pgid, 'SIGTERM');
    }, 10);
    const r = await trackedRun(['sleep', '5'], options);
    expect(r).toMatchObject({ stopped: true, timedOut: false });
  });
  test('the deadline ends a call as timedOut', async () => {
    const { options } = opts({ deadlineMs: Date.now() + 300 });
    const r = await trackedRun(['sleep', '30'], options);
    expect(r).toMatchObject({ timedOut: true, stopped: false });
  });
  test('a group that ignores SIGTERM gets SIGKILL after the grace', async () => {
    const { options } = opts({ deadlineMs: Date.now() + 200, killGraceMs: 300 });
    const r = await trackedRun(['sh', '-c', 'trap "" TERM; sleep 30'], options);
    expect(r.timedOut).toBe(true);
  });
  test('a missing executable is a spawn error, not a throw', async () => {
    const { options, seen } = opts();
    const r = await trackedRun(['/nonexistent/koda-no-such-tool'], options);
    expect(r).toMatchObject({ code: 127, timedOut: false, stopped: false });
    expect(r.spawnError).toBeDefined();
    expect(seen).toEqual([]);
  });
});

describe('step clock', () => {
  test('checkpoint throws StoppedError before DeadlineError; remainingMs is at least 1', () => {
    expect(() => checkpoint({ nowMs: () => 0, deadlineMs: 10, isStopped: () => true })).toThrow(StoppedError);
    expect(() => checkpoint({ nowMs: () => 10, deadlineMs: 10, isStopped: () => false })).toThrow(DeadlineError);
    expect(() => checkpoint({ nowMs: () => 9, deadlineMs: 10, isStopped: () => false })).not.toThrow();
    expect(remainingMs({ nowMs: () => 50, deadlineMs: 10, isStopped: () => false })).toBe(1);
  });
  test('raiseIfInterrupted maps a stopped or timed-out result', () => {
    const base = { code: 0, stdout: '', stderr: '', timedOut: false, stopped: false };
    expect(() => raiseIfInterrupted({ ...base, stopped: true })).toThrow(StoppedError);
    expect(() => raiseIfInterrupted({ ...base, timedOut: true })).toThrow(DeadlineError);
    expect(() => raiseIfInterrupted(base)).not.toThrow();
  });
});
