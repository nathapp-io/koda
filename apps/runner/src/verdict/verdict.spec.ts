import { describe, expect, test } from 'bun:test';
import { mapStatusToSnapshot } from '../watcher/status-snapshot';
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
  test('US-005 AC-4: a PRD naming another branch than expectBranch is branch_mismatch with the PRD branch', () => {
    const text = '{"branchName":"feat/other","userStories":[{"id":"US-001"}]}';
    expect(checkPlanPrd(text, 'feat/add-auth')).toEqual({ ok: false, reason: 'branch_mismatch', branchName: 'feat/other' });
  });
  test('US-005 AC-5: a PRD naming expectBranch passes', () => {
    const text = '{"branchName":"feat/add-auth","userStories":[{"id":"US-001"}]}';
    expect(checkPlanPrd(text, 'feat/add-auth').ok).toBe(true);
  });
  test('US-005 AC-6: without expectBranch a PRD naming any branch passes', () => {
    const text = '{"branchName":"feat/other","userStories":[{"id":"US-001"}]}';
    expect(checkPlanPrd(text).ok).toBe(true);
    expect(checkPlanPrd(text, undefined).ok).toBe(true);
  });
  test('US-005: a PRD that fails an earlier check keeps that reason even when the branch differs', () => {
    expect(checkPlanPrd('{"branchName":"feat/other","userStories":[]}', 'feat/add-auth')).toMatchObject({ ok: false, reason: 'prd.json has no userStories' });
    expect(checkPlanPrd('{"branchName":"feat/other"}', 'feat/add-auth')).toMatchObject({ ok: false, reason: 'prd.json has no userStories' });
    expect(checkPlanPrd(null, 'feat/add-auth')).toMatchObject({ ok: false, reason: 'no prd.json produced' });
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

describe('workflow verdict (US-001)', () => {
  test('AC-1: parseStatusView keeps step, outcome and https url', () => {
    const view = parseStatusView({
      run: { id: 'r', status: 'completed' },
      workflow: { step: 'done', outcome: 'draft', url: 'https://github.com/o/r/pull/1' },
    });
    expect(view?.workflow).toEqual({ step: 'done', outcome: 'draft', url: 'https://github.com/o/r/pull/1' });
  });
  test('AC-2: parseStatusView drops an outcome outside the three values', () => {
    const view = parseStatusView({ run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'failed' } });
    expect(view?.workflow?.step).toBe('done');
    expect(view?.workflow).not.toHaveProperty('outcome');
  });
  test('AC-3: parseStatusView drops a non-https url', () => {
    const view = parseStatusView({ run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft', url: 'http://x/pull/1' } });
    expect(view?.workflow?.step).toBe('done');
    expect(view?.workflow).not.toHaveProperty('url');
  });
  test('AC-4: parseStatusView with no workflow key has no workflow key', () => {
    const view = parseStatusView({ run: { id: 'r', status: 'completed' } });
    expect(view?.run.id).toBe('r');
    expect(view).not.toHaveProperty('workflow');
  });
  test('AC-5: workflow ready with run completed is COMPLETED', () => {
    expect(runVerdict({ cancelRequested: false, status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } } })).toEqual({
      state: 'COMPLETED',
      reason: null,
    });
  });
  test('AC-6: workflow draft with reasons is ESCALATED with joined reasons', () => {
    expect(
      runVerdict({
        cancelRequested: false,
        status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft' } },
        workflowReasons: ['CI failed: test', '1 open finding'],
      }),
    ).toEqual({ state: 'ESCALATED', reason: 'workflow draft: CI failed: test; 1 open finding' });
  });
  test('AC-7: workflow draft with no reasons is ESCALATED with bare reason', () => {
    expect(runVerdict({ cancelRequested: false, status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft' } } })).toEqual({
      state: 'ESCALATED',
      reason: 'workflow draft',
    });
  });
  test('AC-8: workflow local-only with reasons is FAILED', () => {
    expect(
      runVerdict({
        cancelRequested: false,
        status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'local-only' } },
        workflowReasons: ['push failed'],
      }),
    ).toEqual({ state: 'FAILED', reason: 'workflow local-only: push failed' });
  });
  test('AC-9: workflow with no outcome is FAILED with the step', () => {
    expect(runVerdict({ cancelRequested: false, status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'final-gates' } } })).toEqual({
      state: 'FAILED',
      reason: 'workflow ended at step final-gates',
    });
  });
  test('AC-10: cancel wins over a ready workflow', () => {
    expect(runVerdict({ cancelRequested: true, status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'ready' } } })).toEqual({
      state: 'CANCELLED',
      reason: null,
    });
  });
  test('AC-11: 30 reasons of 50 chars clip to exactly 500 starting with the prefix', () => {
    const reasons = Array.from({ length: 30 }, () => 'x'.repeat(50));
    const verdict = runVerdict({
      cancelRequested: false,
      status: { run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft' } },
      workflowReasons: reasons,
    });
    expect(verdict.state).toBe('ESCALATED');
    expect(verdict.reason).toHaveLength(500);
    expect((verdict.reason ?? '').startsWith('workflow draft: ')).toBe(true);
  });
  test('US-001 snapshot: resultPrUrl falls back to the workflow url', () => {
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, workflow: { step: 'done', outcome: 'draft', url: 'https://github.com/o/r/pull/1' } });
    expect(snap.resultPrUrl).toBe('https://github.com/o/r/pull/1');
  });
});
