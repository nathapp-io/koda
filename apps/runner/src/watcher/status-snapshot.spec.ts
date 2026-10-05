import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import type { StatusView } from '../verdict/status-view';
import { formatCost, mapStatusToSnapshot, readStatusFile } from './status-snapshot';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const status: StatusView = {
  run: { id: 'run-2026-10-01T00-00-00-000Z', status: 'running' },
  progress: { total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 },
  cost: { spent: 1.23456 }, current: { storyId: 'US-002', phase: 'implement' }, lastHeartbeat: '2026-10-01T00:01:00.000Z',
};

describe('mapStatusToSnapshot (slice 3 design §1.3)', () => {
  test('maps run id, progress, story, phase, cost and heartbeat', () => {
    expect(mapStatusToSnapshot(status, { logRunId: 'log-7', costRunId: 'cost-7' })).toEqual({
      naxRunId: 'run-2026-10-01T00-00-00-000Z', naxLogRunId: 'log-7', naxCostRunId: 'cost-7',
      progress: { total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 },
      currentStoryId: 'US-002', currentPhase: 'implement', costSpentUsd: '1.2346', heartbeatAt: '2026-10-01T00:01:00.000Z',
    });
  });
  test('omits absent run ids, sends null story/phase between stories, and drops an unparseable heartbeat', () => {
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'running' }, current: null, lastHeartbeat: 'garbage' });
    expect(snap).toEqual({ naxRunId: 'r', currentStoryId: null, currentPhase: null });
  });
  test('maps the finish block and the extras', () => {
    const snap = mapStatusToSnapshot(
      { run: { id: 'r', status: 'completed' }, postRun: { finish: { status: 'passed', result: 'opened', url: 'https://github.com/a/b/pull/1' } } },
      { resultBranch: 'feat/x', resultSha: 'a'.repeat(40) },
    );
    expect(snap).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://github.com/a/b/pull/1', resultBranch: 'feat/x', resultSha: 'a'.repeat(40) });
    const esc = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'blocked' } } });
    expect(esc).toMatchObject({ finishResult: 'escalated', escalationReason: 'blocked' });
    expect(esc).not.toHaveProperty('resultPrUrl');
  });
  test('maps post-run stage statuses, skipping stages without a status (S2b (j) D434)', () => {
    const snap = mapStatusToSnapshot({
      run: { id: 'r', status: 'running' },
      postRun: { acceptance: { status: 'passed' }, regression: {}, finish: { status: 'running' } },
    });
    expect(snap.postRun).toEqual({ acceptance: 'passed', finish: 'running' });
  });
  test('omits postRun when no stage has a status, and keeps the finish mapping unchanged', () => {
    expect(mapStatusToSnapshot({ run: { id: 'r', status: 'running' }, postRun: { regression: {} } })).not.toHaveProperty('postRun');
    expect(mapStatusToSnapshot({ run: { id: 'r', status: 'running' } })).not.toHaveProperty('postRun');
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'opened', url: 'https://github.com/a/b/pull/1' } } });
    expect(snap).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://github.com/a/b/pull/1' });
    expect(snap).not.toHaveProperty('postRun');
  });
  test('clips each stage status to 32 characters', () => {
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'running' }, postRun: { acceptance: { status: 'x'.repeat(50) } } });
    expect(snap.postRun?.acceptance).toBe('x'.repeat(32));
  });
  test('escalationReason is cut to the server limit of 2,000 characters, never inside a surrogate pair (D59)', () => {
    const long = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'x'.repeat(5_000) } } });
    expect(long.escalationReason).toHaveLength(2_000);
    const pair = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: `${'y'.repeat(1_999)}\u{1F600}` } } });
    expect(pair.escalationReason).toBe('y'.repeat(1_999));
  });
});

describe('formatCost', () => {
  test.each([[0, '0.0000'], [1.5, '1.5000'], [0.00004, '0.0000'], [12.34567, '12.3457'], [99999999, '99999999.0000']])('%p -> %p', (input, out) => {
    expect(formatCost(input)).toBe(out);
  });
  test.each([[-1], [NaN], [Infinity], ['1'], [null], [undefined], [1e8]])('%p is dropped', (input) => {
    expect(formatCost(input)).toBeUndefined();
  });
});

describe('readStatusFile', () => {
  test('missing, invalid and valid files are told apart', async () => {
    const dir = await tmp.make('status');
    expect(await readStatusFile(join(dir, 'status.json'))).toEqual({ status: null, problem: 'missing' });
    await writeFile(join(dir, 'status.json'), '{"run":');
    expect(await readStatusFile(join(dir, 'status.json'))).toEqual({ status: null, problem: 'invalid' });
    await writeFile(join(dir, 'status.json'), JSON.stringify({ run: { id: 'r', status: 'running' } }));
    expect(await readStatusFile(join(dir, 'status.json'))).toEqual({ status: { run: { id: 'r', status: 'running' } }, problem: null });
    await mkdir(join(dir, 'sub'));
    expect((await readStatusFile(join(dir, 'sub'))).problem).toBe('invalid');
  });
});
