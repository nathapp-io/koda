import { describe, expect, test } from 'bun:test';
import type { ConfigEditPayload, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { NetworkError, ServerError } from '../sync/http';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { FakeLogShipping } from '../../test/helpers/fake-log-shipping';
import { fakeTime } from '../../test/helpers/fake-time';
import type { ConfigEditSource } from './config-edit-fetch';
import { JobRun, type JobRunDeps } from './job-run';
import { RepoMutex } from './repo-mutex';

const EDIT: ConfigEditPayload = {
  mode: 'edit', baseSha: 'a'.repeat(40), prTitle: 'Tighten rules', prBody: null,
  edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a\n', baseSha: 'b'.repeat(40) }],
};

function build(command: 'CONFIG_EDIT' | 'CONFIG_DRIFT' = 'CONFIG_EDIT', source?: ConfigEditSource) {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const logs = new FakeLogShipping(ex.calls);
  const mutex = new RepoMutex();
  const fetched: Array<[string, number]> = [];
  const deps: JobRunDeps = {
    journal, executor: ex, mutex, log: createMemoryLogger(), now: time.now, sleep: time.sleep, logs,
    uploader: { upload: async () => { throw new Error('config jobs never upload a bundle'); } },
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, logDrainTimeoutMs: 120_000, configJobTimeoutMs: 600_000, configHeartbeatMs: 30_000 },
    configEdits: source ?? { fetch: async (jobId, epoch) => { fetched.push([jobId, epoch]); return command === 'CONFIG_DRIFT' ? { ...EDIT, mode: 'drift', edits: [], prTitle: null } : EDIT; } },
  };
  journal.insertJob({ assign: assignFor(command), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });
  return { time, journal, ex, logs, mutex, fetched, deps, run: new JobRun(deps, 'j1', 1) };
}
type Built = ReturnType<typeof build>;
const events = (b: Built) => b.journal.pendingEvents('j1', 1, 1_000);
const states = (b: Built) => events(b).filter((e) => e.type === 'state').map((e) => e.payload as StateEventPayload);
const stateNames = (b: Built) => states(b).map((s) => s.to);
const snapshots = (b: Built) => events(b).filter((e) => e.type === 'snapshot').map((e) => e.payload as SnapshotEventPayload);
const lifecycles = (b: Built) => events(b).filter((e) => e.type === 'lifecycle').map((e) => (e.payload as { message: string }).message);
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('config job happy path (S3 §3, §5)', () => {
  test('fetch, prepare, RUNNING, run, result snapshot, UPLOADING, COMPLETED with reason ok; no nax, no bundle', async () => {
    const b = build();
    await b.run.start('prepare');
    expect(b.fetched).toEqual([['j1', 1]]);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED', reason: 'ok' });
    const result = snapshots(b).find((s) => s.configResult);
    expect(result).toEqual({
      configResult: { outcome: 'ok', files: ['.nax/rules/a.md', 'CLAUDE.md'] },
      resultBranch: 'nax-config/j1', resultSha: 'd'.repeat(40), resultPrUrl: 'https://example.test/pr/9',
    });
    const all = events(b);
    const resultAt = all.findIndex((e) => e.type === 'snapshot' && (e.payload as SnapshotEventPayload).configResult);
    const uploadingAt = all.findIndex((e) => e.type === 'state' && (e.payload as StateEventPayload).to === 'UPLOADING');
    expect(resultAt).toBeLessThan(uploadingAt);
    expect(b.ex.calls).toEqual(expect.arrayContaining(['prepareConfigJob:j1', 'runConfigJob:j1', 'logs.register:j1', 'logs.drain:j1', 'cleanup:j1']));
    expect(b.ex.calls.some((c) => c.startsWith('prepare:') || c.startsWith('spawn:') || c.startsWith('collectBundle:'))).toBe(false);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ state: 'COMPLETED', pid: null, pgid: null });
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('the executor gets the fetched payload and the deadline (now + configJobTimeoutMs)', async () => {
    const b = build();
    const startedAt = b.time.nowMs();
    await b.run.start('prepare');
    expect(b.ex.configContexts[0]?.payload).toEqual(EDIT);
    expect(b.ex.configContexts[0]?.deadlineMs).toBe(startedAt + 600_000);
  });
  test.each([
    ['no_changes', 'COMPLETED'],
    ['drift', 'COMPLETED'],
    ['conflict', 'FAILED'],
    ['invalid', 'FAILED'],
    ['push_failed', 'FAILED'],
    ['pr_failed', 'FAILED'],
    ['timeout', 'FAILED'],
  ] as const)('outcome %s ends %s with reason = outcome (D471, D488)', async (outcome, state) => {
    const b = build();
    b.ex.configRun = { kind: 'result', result: { outcome, files: ['.nax/rules/a.md'] } };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', state]);
    expect(states(b).at(-1)).toEqual({ to: state, reason: outcome });
    expect(snapshots(b).find((s) => s.configResult)?.configResult).toEqual({ outcome, files: ['.nax/rules/a.md'] });
  });
  test('an oversized result is trimmed to fit the snapshot (D491)', async () => {
    const b = build();
    b.ex.configRun = { kind: 'result', result: { outcome: 'invalid', output: 'x'.repeat(40_000) } };
    await b.run.start('prepare');
    expect(Buffer.byteLength(snapshots(b).find((s) => s.configResult)?.configResult?.output ?? '')).toBeLessThanOrEqual(8_192);
  });
  test('a runner error inside the run is UPLOADING -> FAILED with its reason and no result', async () => {
    const b = build();
    b.ex.configRun = { kind: 'failed', reason: 'workspace: disk full' };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'workspace: disk full' });
    expect(snapshots(b).some((s) => s.configResult)).toBe(false);
  });
  test('steps become lifecycle events; the running subprocess is journaled', async () => {
    const b = build();
    b.ex.onConfigRun = async (ctx) => {
      ctx.step('applied 1 edit(s)');
      ctx.onProcess({ pid: 777, pgid: 777 });
      expect(b.journal.getJob('j1', 1)).toMatchObject({ pid: 777, pgid: 777 });
      ctx.onProcess(null);
    };
    await b.run.start('prepare');
    expect(lifecycles(b)).toContain('applied 1 edit(s)');
  });
  test('a slow run stamps heartbeat snapshots while RUNNING', async () => {
    const b = build();
    b.ex.onConfigRun = async () => { for (let i = 0; i < 4; i += 1) await settle(); };
    await b.run.start('prepare');
    expect(snapshots(b).filter((s) => s.heartbeatAt).length).toBeGreaterThanOrEqual(2);
  });
});

describe('config job before RUNNING (D481)', () => {
  test('a fenced fetch (409) emits nothing and leaves the job to ABANDON', async () => {
    const b = build('CONFIG_EDIT', { fetch: async () => { throw new ServerError(409, 'stale lease', null); } });
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual([]);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
    expect(b.ex.calls).not.toContain('prepareConfigJob:j1');
  });
  test('a fetch that keeps failing is ASSIGNED -> FAILED', async () => {
    const b = build('CONFIG_EDIT', { fetch: async () => { throw new NetworkError('down'); } });
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'config edit fetch failed' }]);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('an invalid payload is ASSIGNED -> FAILED', async () => {
    const b = build('CONFIG_EDIT', { fetch: async () => ({ ...EDIT, edits: [{ path: '.nax/profiles/x.env', op: 'put', content: 'K=1', baseSha: null }] }) });
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'invalid config edit payload' }]);
  });
  test('a failed prepare is ASSIGNED -> FAILED with its reason', async () => {
    const b = build();
    b.ex.configPrepare = { ok: false, reason: 'checkout: default branch not found' };
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'checkout: default branch not found' }]);
    expect(b.ex.calls).not.toContain('runConfigJob:j1');
  });
  test('a cancel recorded before the start ends CANCELLED without fetching', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { cancelRequestedAt: '2026-10-01T00:00:00.000Z' });
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(b.fetched).toEqual([]);
  });
});

describe('config job cancel and halt', () => {
  test('a cancel while RUNNING signals the journaled group and ends RUNNING -> CANCELLED', async () => {
    const b = build();
    b.ex.onConfigRun = async (ctx) => {
      ctx.onProcess({ pid: 777, pgid: 777 });
      b.run.requestCancel();
      expect(ctx.isStopped()).toBe(true);
    };
    b.ex.configRun = { kind: 'stopped' };
    await b.run.start('prepare');
    expect(b.ex.killed).toEqual([{ pgid: 777, signal: 'SIGTERM' }]);
    expect(stateNames(b)).toEqual(['RUNNING', 'CANCELLED']);
  });
  test('a result that arrives after a late cancel is still reported (D489)', async () => {
    const b = build();
    b.ex.onConfigRun = async () => { b.run.requestCancel(); };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('a halt during the run reports nothing more', async () => {
    const b = build();
    b.ex.onConfigRun = async () => { b.run.halt(); };
    b.ex.configRun = { kind: 'stopped' };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING']);
  });
  test('a config job is never resumed from watch: it fails safe', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING' });
    await b.run.start('watch');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'runner error: a config job cannot be resumed' });
  });
});
