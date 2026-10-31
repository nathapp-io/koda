import { Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import type { OpenPullRequest } from '../git-broker/github-app-client';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import type { FleetPrReviewRecord } from './domain/fleet-pr-review.domain';
import { ReviewHeadDispatcher } from './review-head-dispatcher';

const NOW = new Date('2026-11-03T00:00:00.000Z');
const repo = { id: 'r1', projectId: 'p1', owner: 'o', name: 'n', autoReviewEnabledById: 'u1', autoReviewEnabledAt: null,
  autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000' } as FleetRepoRecord;
const pr = (number: number, headSha = `sha-${number}`): OpenPullRequest => ({ number, headSha, draft: false,
  headRepoFullName: 'o/n', updatedAt: NOW });
const row = (number = 3, headSha = `sha-${number}`): FleetPrReviewRecord => ({ id: `row-${number}`, repoId: 'r1',
  prNumber: number, headSha, outcome: 'pending', jobId: null, createdAt: NOW, updatedAt: NOW });

function setup(errors: unknown[] = []) {
  const rows = new Map<string, FleetPrReviewRecord>();
  const reviews = {
    findHead: vi.fn(async (_repo: string, n: number, sha: string) => rows.get(`${n}:${sha}`) ?? null),
    insertPending: vi.fn(async (_repo: string, n: number, sha: string) => { const pending = row(n, sha); rows.set(`${n}:${sha}`, pending); return pending; }),
    markDispatched: vi.fn(async () => undefined),
    markFailed: vi.fn(async (id: string, outcome: string) => { const pending = [...rows.values()].find((item) => item.id === id); if (pending) pending.outcome = outcome; }),
    remove: vi.fn(async (id: string) => { for (const [key, item] of rows) if (item.id === id) rows.delete(key); }),
  };
  const jobs = { dispatch: vi.fn(async () => {
    const error = errors.shift();
    if (error) throw error;
    return { job: { id: 'j1' } };
  }) };
  const dispatcher = new ReviewHeadDispatcher(reviews as never, jobs as never);
  return { dispatcher, reviews, jobs, rows };
}
const run = (dispatcher: ReviewHeadDispatcher, prs: readonly OpenPullRequest[], remaining = 10) =>
  dispatcher.dispatchRepo(repo, prs, { now: NOW, pollMs: 300_000, remaining });

const paused = () => new BudgetPausedException({ id: 'b1', scopeType: 'PROJECT', scopeId: 'p1', scopeKey: 'p1' });

describe('ReviewHeadDispatcher dispatch outcomes', () => {
  it('AC-1, AC-2: removes a fleet.jobs conflict row and retries that head on the next pass', async () => {
    const { dispatcher, reviews, jobs } = setup([new ConflictAppException({ activeJobId: 'j0' }, 'fleet.jobs')]);
    expect(await run(dispatcher, [pr(3)])).toBe(1);
    expect(reviews.remove).toHaveBeenCalledWith('row-3');
    expect(await run(dispatcher, [pr(3)])).toBe(1);
    expect(jobs.dispatch).toHaveBeenCalledTimes(2);
  });

  it('AC-3, AC-4: removes a budget-paused row, stops the repo pass, and counts only its attempt', async () => {
    const { dispatcher, reviews, jobs } = setup([paused()]);
    expect(await run(dispatcher, [pr(3), pr(5)], 2)).toBe(1);
    expect(reviews.remove).toHaveBeenCalledWith('row-3');
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['AC-5', new ValidationAppException({ reason: 'profiles' }, 'fleet.dispatchInput'), 'failed:profiles'],
    ['AC-7', new ValidationAppException({}, 'fleet.dispatchInput'), 'failed:ValidationAppException'],
    ['AC-8', new NotFoundAppException({}, 'fleet.repos'), 'failed:NotFoundAppException'],
    ['AC-9', new FleetDispatchException('disabled'), 'failed:FleetDispatchException'],
  ] as const)('%s: records permanent failure as %s', async (_ac, error, outcome) => {
    const { dispatcher, reviews, rows } = setup([error]);
    expect(await run(dispatcher, [pr(3)])).toBe(1);
    expect(reviews.markFailed).toHaveBeenCalledWith('row-3', outcome);
    expect(rows.get('3:sha-3')?.outcome).toBe(outcome);
  });

  it('AC-6: does not retry a permanently failed head', async () => {
    const { dispatcher, jobs } = setup([new ValidationAppException({ reason: 'profiles' }, 'fleet.dispatchInput')]);
    await run(dispatcher, [pr(3)]);
    expect(await run(dispatcher, [pr(3)])).toBe(0);
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('AC-10: truncates the complete failed outcome to 200 characters', async () => {
    const reason = 'x'.repeat(300);
    const { dispatcher, reviews } = setup([new ValidationAppException({ reason }, 'fleet.dispatchInput')]);
    await run(dispatcher, [pr(3)]);
    const outcome = reviews.markFailed.mock.calls[0]?.[1];
    expect(outcome).toHaveLength(200);
    expect(outcome?.startsWith('failed:')).toBe(true);
  });

  it('AC-11: removes an unexpected error row and resolves', async () => {
    const { dispatcher, reviews } = setup([new Error('boom')]);
    await expect(run(dispatcher, [pr(3)])).resolves.toBe(1);
    expect(reviews.remove).toHaveBeenCalledWith('row-3');
  });

  it('AC-12: warns with repo id, PR number and error name, without its message', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { dispatcher } = setup([new Error('secret payload')]);
    await run(dispatcher, [pr(7)]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('r1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('7'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret payload');
    warn.mockRestore();
  });

  it('AC-13: continues to the next PR after a fleet.jobs conflict', async () => {
    const { dispatcher, jobs } = setup([new ConflictAppException({ activeJobId: 'j0' }, 'fleet.jobs')]);
    expect(await run(dispatcher, [pr(3), pr(5)], 2)).toBe(2);
    expect(jobs.dispatch).toHaveBeenCalledTimes(2);
  });
});
