import { describe, expect, it, vi } from 'vitest';
import { runWithActionContext } from '../../../action-context/action-context';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { MAX_REQUEUE_CANDIDATES, type RequeueCandidate } from '../domain/approval.domain';
import { errorText } from '../fleet-ask-helpers';
import { FleetBudgetOverrideCommand, type BudgetAskInput, type BudgetDecision, type BudgetResult } from './fleet-budget-override.command';

const input: BudgetAskInput = {
  policyId: 'policy-1', scopeType: 'project', scopeId: 'project-1', windowKind: 'calendar_month_utc',
  windowStart: '2026-11-01T00:00:00.000Z', spentUsd: '10', amountUsd: '10', requestedAt: '2026-11-10T09:00:00.000Z',
};

const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `job-${index}`);

const candidate = (jobId: string): RequeueCandidate =>
  ({ jobId, projectId: 'project-1', feature: `f-${jobId}`, queuedAt: new Date('2026-11-01T00:00:00.000Z') });

/** The locked policy row `execute` reads: a project-scope policy, so its route is the project's. */
const policyRecord = {
  id: 'policy-1', scopeType: 'project', scopeId: 'project-1', scopeKey: 'project:project-1', projectId: 'project-1',
  windowKind: 'calendar_month_utc', amountUsd: '10', warnPercent: null, hardStop: true, runningJobs: 'finish',
  pausedAt: new Date('2026-11-01T00:00:00.000Z'), pausedWindowStart: new Date('2026-11-01T00:00:00.000Z'),
  createdById: 'creator-1', updatedById: 'editor-1',
  createdAt: new Date('2026-11-01T00:00:00.000Z'), updatedAt: new Date('2026-11-01T00:00:00.000Z'),
};

/** The command with every collaborator a double; only the members each case exercises are meaningful. */
function build() {
  const mocks = {
    policies: { lockById: vi.fn() },
    budgets: { resume: vi.fn() },
    jobs: { requeue: vi.fn() },
    asks: { findRequeueCandidates: vi.fn().mockResolvedValue([]), findByRequest: vi.fn().mockResolvedValue(null), setOutcome: vi.fn() },
    closer: { closeForPolicy: vi.fn().mockResolvedValue({ approval: null }) },
    audit: { record: vi.fn() },
    txManager: { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) },
  };
  const command = new FleetBudgetOverrideCommand(
    mocks.policies as never, mocks.budgets as never, mocks.jobs as never, mocks.asks as never,
    mocks.closer as never, mocks.audit as never, mocks.txManager as never,
  );
  return { command, mocks };
}

const decided = (approverId = 'approver-1', requestId = 'request-1') => ({ approverId, requestId });
const under = <T>(approval: { approverId: string; requestId: string }, fn: () => Promise<T>): Promise<T> =>
  runWithActionContext({
    actor: { type: 'SYSTEM', id: 'budget' },
    origin: 'system',
    approval: { requiredMode: 'self', satisfiedBy: 'human', approverType: 'USER', approverId: approval.approverId, requestId: approval.requestId },
  }, fn);

describe('FleetBudgetOverrideCommand', () => {
  it('validates and projects the ask input', () => {
    const { command } = build();

    expect(command.parse({ ...input, extra: true })).toEqual(input);
    expect(command.parse({ ...input, scopeId: null })).toEqual({ ...input, scopeId: null });
    expect(() => command.parse({ ...input, policyId: undefined })).toThrow();
    expect(() => command.parse({ ...input, scopeId: undefined })).toThrow();
    expect(() => command.parse({ ...input, scopeId: 7 })).toThrow();
    expect(() => command.parse({ ...input, spentUsd: 10 })).toThrow();
    expect(() => command.parse({ ...input, requestedAt: 'not a date' })).toThrow();
  });

  it('AC-2: de-duplicates the re-queue ids in first-seen order', () => {
    const { command } = build();

    expect(command.parseDecision('approve', { amountUsd: 12.5, requeueJobIds: ['a', 'a', 'b'] }, input))
      .toEqual({ amountUsd: 12.5, requeueJobIds: ['a', 'b'] });
  });

  it('parses its own approve output to itself, and answers no ids when none are given', () => {
    const { command } = build();
    const approval = command.parseDecision('approve', { amountUsd: 20 }, input);

    expect(approval).toEqual({ amountUsd: 20, requeueJobIds: [] });
    expect(command.parseDecision('approve', approval, input)).toEqual(approval);
  });

  it('AC-3: approves with no amount throw', () => {
    expect(() => build().command.parseDecision('approve', {}, input)).toThrow();
    expect(() => build().command.parseDecision('approve', undefined, input)).toThrow();
  });

  it('AC-4: an amount of zero throws', () => {
    expect(() => build().command.parseDecision('approve', { amountUsd: 0 }, input)).toThrow();
    expect(() => build().command.parseDecision('approve', { amountUsd: -1 }, input)).toThrow();
  });

  it('AC-5: more than four decimal places throws', () => {
    expect(() => build().command.parseDecision('approve', { amountUsd: 1.23456 }, input)).toThrow();
    expect(build().command.parseDecision('approve', { amountUsd: 1.2345 }, input)).toEqual({ amountUsd: 1.2345, requeueJobIds: [] });
  });

  it('AC-6: more than the candidate cap of re-queue ids throws', () => {
    expect(() => build().command.parseDecision('approve', { amountUsd: 5, requeueJobIds: ids(MAX_REQUEUE_CANDIDATES + 1) }, input)).toThrow();
    expect(build().command.parseDecision('approve', { amountUsd: 5, requeueJobIds: ids(MAX_REQUEUE_CANDIDATES) }, input))
      .toEqual({ amountUsd: 5, requeueJobIds: ids(MAX_REQUEUE_CANDIDATES) });
  });

  it('refuses an amount over the ceiling and re-queue ids that are not short strings', () => {
    const { command } = build();

    expect(() => command.parseDecision('approve', { amountUsd: 1_000_001 }, input)).toThrow();
    expect(() => command.parseDecision('approve', { amountUsd: 5, requeueJobIds: [''] }, input)).toThrow();
    expect(() => command.parseDecision('approve', { amountUsd: 5, requeueJobIds: ['a'.repeat(65)] }, input)).toThrow();
    expect(() => command.parseDecision('approve', { amountUsd: 5, requeueJobIds: 'job-1' }, input)).toThrow();
    expect(() => command.parseDecision('approve', { amountUsd: '5' }, input)).toThrow();
  });

  it('AC-7: a rejection takes no params', () => {
    expect(() => build().command.parseDecision('reject', { amountUsd: 5 }, input)).toThrow();
    expect(build().command.parseDecision('reject', undefined, input)).toBeUndefined();
  });

  it('AC-14: afterCommit records a failing re-queue and continues with the next', async () => {
    const { command, mocks } = build();
    const conflict = new ConflictAppException({ activeJobId: 'active-1' }, 'fleet.jobs');
    mocks.jobs.requeue.mockImplementation(async (_actorId: string, _projectId: string, jobId: string) => {
      if (jobId === 'job-a') throw conflict;
      return {};
    });
    mocks.asks.findByRequest.mockResolvedValue({ outcome: { resumedAmountUsd: '20', requeueResults: [] } });
    const result: BudgetResult = { resumedAmountUsd: '20', requeue: [candidate('job-a'), candidate('job-b')], refused: [] };
    const decision: BudgetDecision = { amountUsd: 20, requeueJobIds: ['job-a', 'job-b'] };

    await under(decided(), () => command.afterCommit(input, decision, result));

    expect(mocks.jobs.requeue.mock.calls).toEqual([
      ['approver-1', 'project-1', 'job-a'],
      ['approver-1', 'project-1', 'job-b'],
    ]);
    expect(mocks.txManager.run).toHaveBeenCalledTimes(1);
    const [, outcome] = mocks.asks.setOutcome.mock.calls[0];
    expect(outcome).toEqual({
      resumedAmountUsd: '20',
      requeueResults: [{ jobId: 'job-a', ok: false, error: errorText(conflict) }, { jobId: 'job-b', ok: true }],
    });
    expect(outcome.requeueResults[0].error).toBe('{"code":"fleet.jobs","args":{"activeJobId":"active-1"}}');
  });

  it('afterCommit keeps the refused entries execute recorded ahead of the re-queue results', async () => {
    const { command, mocks } = build();
    mocks.asks.findByRequest.mockResolvedValue({
      outcome: { resumedAmountUsd: '20', requeueResults: [{ jobId: 'gone', ok: false, error: 'not a re-queue candidate' }] },
    });
    const result: BudgetResult = { resumedAmountUsd: '20', requeue: [candidate('job-a')], refused: ['gone'] };

    await under(decided(), () => command.afterCommit(input, { amountUsd: 20, requeueJobIds: ['gone', 'job-a'] }, result));

    expect(mocks.asks.setOutcome.mock.calls[0]).toEqual(['request-1', {
      resumedAmountUsd: '20',
      requeueResults: [{ jobId: 'gone', ok: false, error: 'not a re-queue candidate' }, { jobId: 'job-a', ok: true }],
    }]);
  });

  it('projects the result without the candidate rows', () => {
    const { command } = build();

    expect(command.toResult({ resumedAmountUsd: '20', requeue: [candidate('job-a')], refused: ['gone'] })).toEqual({ resumedAmountUsd: '20' });
  });

  it('US-007 AC-12: execute closes the policy\'s other pending ask as superseded in the execution transaction', async () => {
    const { command, mocks } = build();
    mocks.policies.lockById.mockResolvedValue(policyRecord);
    mocks.budgets.resume.mockResolvedValue({ amountUsd: '20' });
    const closed = { approval: { id: 'other-1' } };
    mocks.closer.closeForPolicy.mockResolvedValue(closed);

    await under(decided(), () => command.execute(input, { amountUsd: 20, requeueJobIds: [] }));

    // The executing request is `approved` by now, so it is never the ask the closer finds pending.
    expect(mocks.closer.closeForPolicy).toHaveBeenCalledWith('policy-1', {
      status: 'cancelled', resolvedBy: 'superseded', actor: { type: 'USER', id: 'approver-1', responsibleUserId: 'approver-1' },
    }, expect.any(Date));
  });

  it('US-007: execute still records the new cap when the policy had no other pending ask', async () => {
    const { command, mocks } = build();
    mocks.policies.lockById.mockResolvedValue(policyRecord);
    mocks.budgets.resume.mockResolvedValue({ amountUsd: '20' });

    const result = await under(decided(), () => command.execute(input, { amountUsd: 20, requeueJobIds: [] }));

    expect(result.resumedAmountUsd).toBe('20');
    expect(mocks.asks.setOutcome).toHaveBeenCalledWith('request-1', { resumedAmountUsd: '20', requeueResults: [] });
  });
});
