import { currentBookkeepingReason, type BookkeepingReason } from '../../action-context/audit-coverage';
import type { OpenPullRequest } from '../git-broker/github-app-client';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import type { FleetPrReviewRecord } from './domain/fleet-pr-review.domain';
import { ReviewHeadDispatcher } from './review-head-dispatcher';

const ENABLED_AT = new Date('2026-11-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-11-02T00:00:00.000Z');
const NOW = new Date('2026-11-03T00:00:00.000Z');
const POLL_MS = 300_000;
const MINUTE = 60_000;

const repoRecord = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
  id: 'r1', projectId: 'p1', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
  githubInstallationId: 1n, createdById: 'creator', createdAt: ENABLED_AT,
  autoReview: true, autoReviewProfiles: ['native-ds'], autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: 'u1', autoReviewEnabledByType: 'USER', autoReviewEnabledAt: ENABLED_AT,
  ...over,
});

const pullRequest = (over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  number: 7, headSha: 'aaa', draft: false, headRepoFullName: 'o/n', updatedAt: UPDATED_AT, ...over,
});

const reviewRow = (over: Partial<FleetPrReviewRecord> = {}): FleetPrReviewRecord => ({
  id: 'row-1', repoId: 'r1', prNumber: 7, headSha: 'aaa', jobId: null, outcome: 'pending',
  createdAt: NOW, updatedAt: NOW, ...over,
});

type WriteCall = 'insertPending' | 'markDispatched' | 'markFailed' | 'remove';

interface RecordedWrite {
  call: WriteCall;
  /** The bookkeeping reason active when the write happened. */
  reason: BookkeepingReason | undefined;
}

/**
 * The in-memory `IFleetPrReviewRepository` the plan asks for; every write records the bookkeeping reason
 * that was active, so a write outside `bookkeeping()` is visible.
 */
function createReviews(rows: readonly FleetPrReviewRecord[] = []) {
  let seq = 0;
  const state = { rows: [...rows], writes: [] as RecordedWrite[] };
  const note = (call: WriteCall): void => { state.writes.push({ call, reason: currentBookkeepingReason() }); };
  const find = (id: string): FleetPrReviewRecord | undefined => state.rows.find((r) => r.id === id);

  return {
    state,
    findHead: vi.fn(async (repoId: string, prNumber: number, headSha: string) =>
      state.rows.find((r) => r.repoId === repoId && r.prNumber === prNumber && r.headSha === headSha) ?? null),
    insertPending: vi.fn(async (repoId: string, prNumber: number, headSha: string) => {
      note('insertPending');
      seq += 1;
      const row = reviewRow({ id: `row-${seq}`, repoId, prNumber, headSha, createdAt: NOW, updatedAt: NOW });
      state.rows.push(row);
      return row;
    }),
    markDispatched: vi.fn(async (id: string, jobId: string) => {
      note('markDispatched');
      const row = find(id);
      if (row) Object.assign(row, { outcome: 'dispatched', jobId });
    }),
    markFailed: vi.fn(async (id: string, outcome: string) => {
      note('markFailed');
      const row = find(id);
      if (row) Object.assign(row, { outcome });
    }),
    remove: vi.fn(async (id: string) => {
      note('remove');
      state.rows = state.rows.filter((r) => r.id !== id);
    }),
    findPrincipalAccess: vi.fn(),
  };
}

type Reviews = ReturnType<typeof createReviews>;

function createDispatcher(reviews: Reviews = createReviews()) {
  const jobs = { dispatch: vi.fn().mockResolvedValue({ job: { id: 'j1' } }) };
  const dispatcher = new ReviewHeadDispatcher(reviews as never, jobs as never);
  return { dispatcher, reviews, jobs };
}

function run(
  dispatcher: ReviewHeadDispatcher,
  prs: readonly OpenPullRequest[],
  opts: { repo?: FleetRepoRecord; remaining?: number; onAttempt?: () => void } = {},
): Promise<number> {
  return dispatcher.dispatchRepo(opts.repo ?? repoRecord(), prs, {
    now: NOW, pollMs: POLL_MS, remaining: opts.remaining ?? 10,
    ...(opts.onAttempt === undefined ? {} : { onAttempt: opts.onAttempt }),
  });
}

describe('ReviewHeadDispatcher.dispatchRepo', () => {
  it('AC-1: dispatches one REVIEW job for a new head with the repo auto-review settings', async () => {
    const { dispatcher, jobs } = createDispatcher();
    await run(dispatcher, [pullRequest()]);

    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(jobs.dispatch).toHaveBeenCalledWith(
      'u1',
      'p1',
      { command: 'REVIEW', repoId: 'r1', prNumber: 7, profiles: ['native-ds'], maxCostUsd: 1 },
      { auditKey: 'system.pr-review.dispatch' },
    );
  });

  it('AC-2: marks the head dispatched with the job id and answers one call', async () => {
    const { dispatcher, reviews } = createDispatcher();

    expect(await run(dispatcher, [pullRequest()])).toBe(1);
    expect(reviews.markDispatched).toHaveBeenCalledWith('row-1', 'j1');
    expect(reviews.state.rows[0]).toMatchObject({ headSha: 'aaa', outcome: 'dispatched', jobId: 'j1' });
  });

  it('AC-3: does not dispatch a head that already has a dispatched row', async () => {
    const { dispatcher, jobs } = createDispatcher(createReviews([reviewRow({ outcome: 'dispatched', jobId: 'j0' })]));

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-4: dispatches the same PR again once it reaches a new head', async () => {
    const { dispatcher, jobs } = createDispatcher(createReviews([reviewRow({ outcome: 'dispatched', jobId: 'j0' })]));

    expect(await run(dispatcher, [pullRequest({ headSha: 'bbb' })])).toBe(1);
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(jobs.dispatch.mock.calls[0]?.[2]).toMatchObject({ prNumber: 7 });
  });

  it('AC-5: does not dispatch a head that has a failed row', async () => {
    const { dispatcher, jobs } = createDispatcher(createReviews([reviewRow({ outcome: 'failed:profiles' })]));

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-6: does not dispatch a draft PR', async () => {
    const { dispatcher, jobs } = createDispatcher();

    expect(await run(dispatcher, [pullRequest({ draft: true })])).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it.each(['fork/n', null])('AC-7: does not dispatch a PR whose head repo is %s', async (headRepoFullName) => {
    const { dispatcher, jobs } = createDispatcher();

    expect(await run(dispatcher, [pullRequest({ headRepoFullName })])).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-8: dispatches a PR whose head repo is the repo, compared case-insensitively', async () => {
    const { dispatcher, jobs } = createDispatcher();

    expect(await run(dispatcher, [pullRequest({ headRepoFullName: 'O/N' })])).toBe(1);
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('AC-9: does not dispatch a PR last updated before auto-review was enabled', async () => {
    const { dispatcher, jobs } = createDispatcher();

    expect(await run(dispatcher, [pullRequest({ updatedAt: new Date(ENABLED_AT.getTime() - 1) })])).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('carries on with every PR when the repo has no enable time', async () => {
    const { dispatcher, jobs } = createDispatcher();

    expect(await run(dispatcher, [pullRequest({ updatedAt: new Date('2020-01-01T00:00:00.000Z') })], {
      repo: repoRecord({ autoReviewEnabledAt: null }),
    })).toBe(1);
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('AC-10: removes a pending row older than one poll interval and dispatches again', async () => {
    const stale = reviewRow({ createdAt: new Date(NOW.getTime() - 10 * MINUTE) });
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([stale]));

    expect(await run(dispatcher, [pullRequest()])).toBe(1);
    expect(reviews.remove).toHaveBeenCalledWith('row-1');
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('AC-11: does not dispatch while another pass holds a fresh pending claim', async () => {
    const fresh = reviewRow({ createdAt: new Date(NOW.getTime() - MINUTE) });
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([fresh]));

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(reviews.remove).not.toHaveBeenCalled();
    expect(reviews.insertPending).not.toHaveBeenCalled();
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-12: walks the PRs in ascending number and stops at the remaining budget', async () => {
    const { dispatcher, jobs } = createDispatcher();
    const prs = [pullRequest({ number: 9, headSha: 's9' }), pullRequest({ number: 3, headSha: 's3' }), pullRequest({ number: 5, headSha: 's5' })];

    expect(await run(dispatcher, prs, { remaining: 2 })).toBe(2);
    expect(jobs.dispatch.mock.calls.map((call) => (call[2] as { prNumber: number }).prNumber)).toEqual([3, 5]);
  });

  it('AC-13: skips a head another pass claimed when the insert loses', async () => {
    const { dispatcher, reviews, jobs } = createDispatcher();
    reviews.insertPending.mockResolvedValue(null);

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-14: runs every FleetPrReview write inside fleet.pr-review-bookkeeping bookkeeping', async () => {
    const stale = reviewRow({ createdAt: new Date(NOW.getTime() - 10 * MINUTE) });
    const { dispatcher, reviews } = createDispatcher(createReviews([stale]));

    await run(dispatcher, [pullRequest()]);

    expect(reviews.state.writes.map((write: RecordedWrite) => write.call)).toEqual(['remove', 'insertPending', 'markDispatched']);
    expect(reviews.state.writes.map((write: RecordedWrite) => write.reason))
      .toEqual(['fleet.pr-review-bookkeeping', 'fleet.pr-review-bookkeeping', 'fleet.pr-review-bookkeeping']);
  });

  it('dispatches nothing when the repo has no stored enabler', async () => {
    const { dispatcher, jobs } = createDispatcher();

    expect(await run(dispatcher, [pullRequest()], { repo: repoRecord({ autoReviewEnabledById: null }) })).toBe(0);
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  /**
   * US-009 fix (F1): the pass's cap counts dispatch attempts, and a repo whose run *fails* after dispatching
   * still spent them. `onAttempt` is how the count reaches the pass when `dispatchRepo` cannot return it.
   */
  it('reports every dispatch attempt through onAttempt, before the dispatch call it counts', async () => {
    const { dispatcher, jobs } = createDispatcher();
    const onAttempt = vi.fn(() => {
      // The attempt is counted before the dispatch it belongs to, so a throw from that dispatch stays counted.
      expect(onAttempt.mock.calls).toHaveLength(jobs.dispatch.mock.calls.length + 1);
    });

    expect(await run(dispatcher, [
      pullRequest({ number: 3, headSha: 's3' }),
      pullRequest({ number: 5, headSha: 's5' }),
    ], { onAttempt })).toBe(2);

    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it('keeps an attempt counted when the dispatch after it throws', async () => {
    const { dispatcher, jobs } = createDispatcher();
    jobs.dispatch.mockRejectedValue(new TypeError('dispatch boom'));
    const onAttempt = vi.fn();

    expect(await run(dispatcher, [pullRequest()], { onAttempt })).toBe(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it('keeps an attempt counted when the bookkeeping after it throws, so the run rejects with the count already told', async () => {
    const { dispatcher, reviews } = createDispatcher();
    reviews.markDispatched.mockRejectedValue(new Error('bookkeeping boom'));
    const onAttempt = vi.fn();

    await expect(run(dispatcher, [pullRequest()], { onAttempt })).rejects.toThrow('bookkeeping boom');
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it('reports no attempt for a head that never reaches a dispatch', async () => {
    const { dispatcher } = createDispatcher(createReviews([reviewRow({ outcome: 'dispatched', jobId: 'j0' })]));
    const onAttempt = vi.fn();

    expect(await run(dispatcher, [pullRequest()], { onAttempt })).toBe(0);
    expect(onAttempt).not.toHaveBeenCalled();
  });
});
