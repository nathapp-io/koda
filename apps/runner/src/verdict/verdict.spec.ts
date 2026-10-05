import { describe, expect, test } from 'bun:test';
import { checkPlanPrd, planVerdict } from './plan-verdict';
import { runVerdict } from './run-verdict';
import { isFinalStatus, parseStatusView, type StatusView } from './status-view';

const status = (runStatus: string, finish?: StatusView['postRun'] extends infer P ? (P extends { finish?: infer F } ? F : never) : never): StatusView => ({
  run: { id: 'run-1', status: runStatus }, ...(finish ? { postRun: { finish } } : {}),
});

describe('runVerdict (S1 spec §5.2 step 6, first matching row wins)', () => {
  test('cancel comes first, whatever nax wrote (SIGTERM makes nax write crashed)', () => {
    expect(runVerdict({ cancelRequested: true, status: status('crashed') })).toEqual({ state: 'CANCELLED', reason: null });
    expect(runVerdict({ cancelRequested: true, status: null })).toEqual({ state: 'CANCELLED', reason: null });
    expect(runVerdict({ cancelRequested: true, status: status('completed', { status: 'passed', result: 'opened' }) }).state).toBe('CANCELLED');
  });
  test('an escalated finish is ESCALATED with nax reason, even when the run failed', () => {
    expect(runVerdict({ cancelRequested: false, status: status('completed', { status: 'passed', result: 'escalated', escalationReason: 'review blocked' }) })).toEqual({ state: 'ESCALATED', reason: 'review blocked' });
    expect(runVerdict({ cancelRequested: false, status: status('failed', { result: 'escalated' }) })).toEqual({ state: 'ESCALATED', reason: 'escalated' });
  });
  test.each([
    ['no finish block', undefined],
    ['finish skipped', { status: 'skipped', reason: 'branch' }],
    ['opened', { status: 'passed', result: 'opened' }],
    ['promoted', { status: 'passed', result: 'promoted' }],
    ['already-ready', { status: 'passed', result: 'already-ready' }],
    ['nothing-to-finish', { status: 'passed', result: 'nothing-to-finish' }],
  ])('completed with %s is COMPLETED', (_label, finish) => {
    expect(runVerdict({ cancelRequested: false, status: status('completed', finish as never) })).toEqual({ state: 'COMPLETED', reason: null });
  });
  test('a completed run whose finish failed is FAILED with that fact', () => {
    expect(runVerdict({ cancelRequested: false, status: status('completed', { status: 'failed' }) })).toEqual({ state: 'FAILED', reason: 'finish failed' });
  });
  test.each(['failed', 'stalled', 'crashed', 'precheck-failed', 'cost-limit', 'aborted', 'running'])('run status %s is FAILED with the status as reason', (s) => {
    expect(runVerdict({ cancelRequested: false, status: status(s) })).toEqual({ state: 'FAILED', reason: `run status: ${s}` });
  });
  test('no status.json is FAILED', () => {
    expect(runVerdict({ cancelRequested: false, status: null })).toEqual({ state: 'FAILED', reason: 'no status.json' });
  });
});

describe('checkPlanPrd and planVerdict', () => {
  test('a valid PRD passes and carries its branch name', () => {
    expect(checkPlanPrd('{"branchName":"feat/x","userStories":[{"id":"US-001"}]}')).toEqual({ ok: true, reason: null, branchName: 'feat/x' });
  });
  test.each([
    [null, 'no prd.json produced'],
    ['nope', 'prd.json is not valid JSON'],
    ['{"userStories":[]}', 'prd.json has no userStories'],
    ['{"branchName":"b"}', 'prd.json has no userStories'],
  ])('%j fails with %s', (text, reason) => {
    expect(checkPlanPrd(text)).toMatchObject({ ok: false, reason });
  });
  test('cancel wins, then failure, then success', () => {
    const good = checkPlanPrd('{"userStories":[{"id":"a"}]}');
    const bad = checkPlanPrd(null);
    expect(planVerdict({ cancelRequested: true, check: good })).toEqual({ state: 'CANCELLED', reason: null });
    expect(planVerdict({ cancelRequested: false, check: bad })).toEqual({ state: 'FAILED', reason: 'no prd.json produced' });
    expect(planVerdict({ cancelRequested: false, check: good })).toEqual({ state: 'COMPLETED', reason: null });
  });
});

describe('parseStatusView', () => {
  test('keeps the fields the runner uses and drops the rest', () => {
    const view = parseStatusView({
      version: 1, run: { id: 'run-1', status: 'running', pid: 42, feature: 'x' }, progress: { total: 3, passed: 1, note: 'x' }, cost: { spent: 1.5, limit: null },
      current: { storyId: 'US-001', phase: 'implement', title: 't' }, lastHeartbeat: '2026-10-01T00:00:00.000Z', updatedAt: 'u',
      postRun: { finish: { status: 'passed', result: 'opened', url: 'https://x/pr/1', extra: 1 } },
    });
    expect(view).toEqual({
      run: { id: 'run-1', status: 'running', pid: 42 }, progress: { total: 3, passed: 1 }, cost: { spent: 1.5 },
      current: { storyId: 'US-001', phase: 'implement' }, lastHeartbeat: '2026-10-01T00:00:00.000Z', updatedAt: 'u',
      postRun: { finish: { status: 'passed', result: 'opened', url: 'https://x/pr/1' } },
    });
  });
  test('reads acceptance and regression status and drops everything else in those stages (S2b (j) §1.1)', () => {
    const view = parseStatusView({
      run: { id: 'r', status: 'running' },
      postRun: {
        acceptance: { status: 'running', lastRunAt: 'x', failedACs: ['AC-1'] },
        regression: { status: 7 },
        finish: { status: 'not-run' },
        gates: { acceptance: 'passed' },
      },
    });
    expect(view?.postRun).toEqual({ acceptance: { status: 'running' }, regression: {}, finish: { status: 'not-run' } });
  });
  test('a postRun that is not an object, or has no stage objects, leaves postRun undefined', () => {
    expect(parseStatusView({ run: { id: 'r', status: 'running' }, postRun: 'x' })?.postRun).toBeUndefined();
    expect(parseStatusView({ run: { id: 'r', status: 'running' }, postRun: { acceptance: 'passed' } })?.postRun).toBeUndefined();
  });
  test('current null is preserved; missing run.id or run.status is not a status file', () => {
    expect(parseStatusView({ run: { id: 'r', status: 'completed' }, current: null })?.current).toBeNull();
    for (const raw of [null, [], {}, { run: {} }, { run: { id: 'r' } }, { run: { id: 1, status: 's' } }]) expect(parseStatusView(raw)).toBeNull();
  });
  test('isFinalStatus is everything but running', () => {
    expect(isFinalStatus({ run: { id: 'r', status: 'running' } })).toBe(false);
    expect(isFinalStatus({ run: { id: 'r', status: 'crashed' } })).toBe(true);
  });
});
