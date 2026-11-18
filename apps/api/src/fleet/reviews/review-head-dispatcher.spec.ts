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
  id: 'row-1', repoId: 'r1', prNumber: 7, headSha: 'aaa', jobId: null, outcome: 'pending', followUpEventId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});

type WriteCall = 'insertPending' | 'markDispatched' | 'markDispatchedIfPending' | 'markFailed' | 'remove' | 'removeStalePending';

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
    markDispatchedIfPending: vi.fn(async (id: string, jobId: string) => {
      note('markDispatchedIfPending');
      const row = find(id);
      if (!row || row.outcome !== 'pending' || row.jobId !== null) return false;
      Object.assign(row, { outcome: 'dispatched', jobId });
      return true;
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
    /** The atomic stale removal: only an old, still-pending claim with no job is deleted. */
    removeStalePending: vi.fn(async (id: string, staleBefore: Date) => {
      note('removeStalePending');
      const row = find(id);
      if (!row || row.outcome !== 'pending' || row.jobId !== null || row.createdAt.getTime() >= staleBefore.getTime()) return false;
      state.rows = state.rows.filter((r) => r.id !== id);
      return true;
    }),
    findPrincipalAccess: vi.fn(),
  };
}

type Reviews = ReturnType<typeof createReviews>;

function createDispatcher(reviews: Reviews = createReviews()) {
  /** Review B4: the real dispatch runs the fence inside its insert transaction; the stub runs it too. */
  const jobs = {
    dispatch: vi.fn(async (
      _actorId: string,
      _projectId: string,
      _dto: unknown,
      opts?: { fence?: (jobId: string) => Promise<void> },
    ) => {
      await opts?.fence?.('j1');
      return { job: { id: 'j1' } };
    }),
    findReviewJobIdBetween: vi.fn().mockResolvedValue(null),
  };
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
      { auditKey: 'system.pr-review.dispatch', fence: expect.any(Function) },
    );
  });

  it('AC-2: marks the head dispatched with the job id and answers one call', async () => {
    const { dispatcher, reviews } = createDispatcher();

    expect(await run(dispatcher, [pullRequest()])).toBe(1);
    expect(reviews.markDispatchedIfPending).toHaveBeenCalledWith('row-1', 'j1');
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
    expect(reviews.removeStalePending).toHaveBeenCalledWith('row-1', new Date(NOW.getTime() - POLL_MS));
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

    expect(reviews.state.writes.map((write: RecordedWrite) => write.call)).toEqual(['removeStalePending', 'insertPending', 'markDispatchedIfPending']);
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
    reviews.markDispatchedIfPending.mockRejectedValue(new Error('bookkeeping boom'));
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

  /**
   * Review B4: the claim link is written inside the job insert's transaction, so a stale-claim sweep cannot remove
   * the claim between the insert and its link. A fence that loses the claim must not settle it as failed or remove
   * it: the row is already gone or settled by whoever won.
   */
  describe('claim fence (review B4)', () => {
    it('links the claim from inside the dispatch transaction', async () => {
      const { dispatcher, reviews, jobs } = createDispatcher();

      await run(dispatcher, [pullRequest()]);

      const opts = jobs.dispatch.mock.calls[0]?.[3] as { fence: (jobId: string) => Promise<void> };
      expect(typeof opts.fence).toBe('function');
      expect(reviews.markDispatchedIfPending).toHaveBeenCalledWith('row-1', 'j1');
      expect(reviews.state.writes.map((write: RecordedWrite) => write.call)).toContain('markDispatchedIfPending');
    });

    it('leaves a lost claim alone instead of removing or failing it', async () => {
      const { dispatcher, reviews } = createDispatcher();
      // A stale-claim sweep won the race: the row is no longer pending, so the conditional link changes nothing.
      reviews.markDispatchedIfPending.mockResolvedValue(false);

      await run(dispatcher, [pullRequest()]);

      expect(reviews.remove).not.toHaveBeenCalled();
      expect(reviews.markFailed).not.toHaveBeenCalled();
    });

    it('does not roll the claim back when the fence wins', async () => {
      const { dispatcher, reviews } = createDispatcher();

      await run(dispatcher, [pullRequest()]);

      expect(reviews.removeStalePending).not.toHaveBeenCalled();
      expect(reviews.state.rows[0]).toMatchObject({ outcome: 'dispatched', jobId: 'j1' });
    });
  });
});

/**
 * US-006: a stale pending claim whose pass already created a job. The head was dispatched, so the claim is
 * recovered by linking that job instead of being removed and dispatched a second time.
 */
describe('ReviewHeadDispatcher stale claim recovery', () => {
  const staleRow = (over: Partial<FleetPrReviewRecord> = {}): FleetPrReviewRecord =>
    reviewRow({ createdAt: new Date(NOW.getTime() - 10 * MINUTE), ...over });

  it('US-006 AC-1a: looks for a job inside the stale claim dispatch window', async () => {
    const stale = staleRow();
    const { dispatcher, jobs } = createDispatcher(createReviews([stale]));
    jobs.findReviewJobIdBetween.mockResolvedValue('job-1');

    await run(dispatcher, [pullRequest()]);

    expect(jobs.findReviewJobIdBetween).toHaveBeenCalledWith(
      'r1', 7, stale.createdAt, new Date(stale.createdAt.getTime() + POLL_MS),
    );
  });

  it('US-006 AC-1b: links the found job to the stale claim', async () => {
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([staleRow()]));
    jobs.findReviewJobIdBetween.mockResolvedValue('job-1');

    await run(dispatcher, [pullRequest()]);

    expect(reviews.markDispatchedIfPending).toHaveBeenCalledWith('row-1', 'job-1');
    expect(reviews.state.rows[0]).toMatchObject({ outcome: 'dispatched', jobId: 'job-1' });
  });

  it('US-006 AC-2a: neither removes the claim nor dispatches when a job is found', async () => {
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([staleRow()]));
    jobs.findReviewJobIdBetween.mockResolvedValue('job-1');

    await run(dispatcher, [pullRequest()]);

    expect(reviews.remove).not.toHaveBeenCalled();
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('US-006 AC-2b: resolves to zero dispatch calls when a job is found', async () => {
    const { dispatcher, jobs } = createDispatcher(createReviews([staleRow()]));
    jobs.findReviewJobIdBetween.mockResolvedValue('job-1');

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
  });

  it('US-006 AC-3a: skips only the PR whose lookup failed and dispatches the next one', async () => {
    const stale = staleRow({ prNumber: 3, headSha: 's3' });
    const { dispatcher, jobs } = createDispatcher(createReviews([stale]));
    jobs.findReviewJobIdBetween.mockRejectedValue(new Error('lookup boom'));

    expect(await run(dispatcher, [pullRequest({ number: 3, headSha: 's3' }), pullRequest({ number: 5, headSha: 's5' })])).toBe(1);
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(jobs.dispatch.mock.calls[0]?.[2]).toMatchObject({ prNumber: 5 });
  });

  it('US-006 AC-3b: keeps the claim whose lookup failed', async () => {
    const stale = staleRow({ prNumber: 3, headSha: 's3' });
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([stale]));
    jobs.findReviewJobIdBetween.mockRejectedValue(new Error('lookup boom'));

    await run(dispatcher, [pullRequest({ number: 3, headSha: 's3' }), pullRequest({ number: 5, headSha: 's5' })]);

    expect(reviews.state.rows.map((row) => row.id)).toContain('row-1');
    expect(reviews.remove).not.toHaveBeenCalledWith('row-1');
  });

  it('US-006 AC-9: leaves the claim alone when the conditional link changes nothing', async () => {
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([staleRow()]));
    jobs.findReviewJobIdBetween.mockResolvedValue('job-1');
    reviews.markDispatchedIfPending.mockResolvedValue(false);

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(reviews.markDispatchedIfPending).toHaveBeenCalledWith('row-1', 'job-1');
    expect(reviews.remove).not.toHaveBeenCalled();
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  /**
   * F1: the removal must be conditional too. Another stale-claim path (the flow's claim service) can link a job
   * between this lookup and the removal; an unconditional delete would drop that freshly settled claim and let the
   * head be dispatched a second time.
   */
  it('US-006 F1: reopens no head when the conditional removal loses a race to another claim path', async () => {
    const { dispatcher, reviews, jobs } = createDispatcher(createReviews([staleRow()]));
    // The lookup still says "no job"; another path settles the claim before this pass removes it.
    jobs.findReviewJobIdBetween.mockResolvedValue(null);
    reviews.removeStalePending.mockResolvedValue(false);

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(reviews.removeStalePending).toHaveBeenCalledWith('row-1', new Date(NOW.getTime() - POLL_MS));
    expect(reviews.remove).not.toHaveBeenCalled();
    expect(jobs.dispatch).not.toHaveBeenCalled();
  });

  it('US-006 F1: keeps the row another path already settled and does not insert a second claim', async () => {
    const { dispatcher, reviews } = createDispatcher(createReviews([staleRow()]));
    reviews.removeStalePending.mockImplementation(async (id: string) => {
      // Simulate the interleaving: the row is settled with a job before this pass's conditional delete runs.
      const row = reviews.state.rows.find((item) => item.id === id);
      if (row) Object.assign(row, { outcome: 'dispatched', jobId: 'job-9' });
      return false;
    });

    expect(await run(dispatcher, [pullRequest()])).toBe(0);
    expect(reviews.state.rows[0]).toMatchObject({ outcome: 'dispatched', jobId: 'job-9' });
    expect(reviews.insertPending).not.toHaveBeenCalled();
  });
});
