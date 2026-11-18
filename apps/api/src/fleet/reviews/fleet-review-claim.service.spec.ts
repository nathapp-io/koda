import { FleetReviewClaimService } from './fleet-review-claim.service';
import { type FleetPrReviewRecord, type IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import { FleetReviewsModule } from './fleet-reviews.module';
import { FleetReviewEventsService } from './fleet-review-events.service';

describe('FleetReviewClaimService', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const row = (overrides: Partial<FleetPrReviewRecord> = {}): FleetPrReviewRecord => ({
    id: 'claim-1', repoId: 'repo-1', prNumber: 12, headSha: 'h1', jobId: null,
    outcome: 'pending', createdAt: now, updatedAt: now, ...overrides,
  });
  let repository: IFleetPrReviewRepository;
  let jobs: { findReviewJobIdBetween: ReturnType<typeof vi.fn> };
  let service: FleetReviewClaimService;
  beforeEach(() => {
    repository = {
      findHead: vi.fn().mockResolvedValue(null), insertPending: vi.fn().mockResolvedValue(row()),
      markDispatched: vi.fn().mockResolvedValue(undefined), markDispatchedIfPending: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn(), remove: vi.fn().mockResolvedValue(undefined),
      removeStalePending: vi.fn().mockResolvedValue(true), findPrincipalAccess: vi.fn(),
    };
    jobs = { findReviewJobIdBetween: vi.fn().mockResolvedValue(null) };
    service = new FleetReviewClaimService(repository, { prReviewPollMs: 60_000 }, jobs as never);
  });

  it('AC-1: returns the inserted claim id', async () => {
    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'claimed', claimId: 'claim-1' });
  });
  it('AC-2: reports an existing job as owned', async () => {
    vi.mocked(repository.insertPending).mockResolvedValue(null);
    vi.mocked(repository.findHead).mockResolvedValue(row({ jobId: 'j9', outcome: 'dispatched' }));
    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'owned', jobId: 'j9' });
  });
  it('AC-3: live pending claims are busy', async () => {
    vi.mocked(repository.insertPending).mockResolvedValue(null);
    vi.mocked(repository.findHead).mockResolvedValue(row({ createdAt: new Date(now.getTime() - 59_999) }));
    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'busy' });
  });
  it('AC-4: removes stale pending claim', async () => {
    vi.mocked(repository.insertPending).mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 'claim-2' }));
    vi.mocked(repository.findHead).mockResolvedValue(row({ createdAt: new Date(now.getTime() - 60_001) }));
    await service.claimHead('repo-1', 12, 'h1', now);
    expect(repository.removeStalePending).toHaveBeenCalledWith('claim-1', new Date(now.getTime() - 60_000));
  });
  it('does not reclaim a stale row concurrently settled before conditional removal', async () => {
    vi.mocked(repository.insertPending).mockResolvedValue(null);
    vi.mocked(repository.findHead)
      .mockResolvedValueOnce(row({ createdAt: new Date(now.getTime() - 60_001) }))
      .mockResolvedValueOnce(row({ jobId: 'j9', outcome: 'dispatched' }));
    vi.mocked(repository.removeStalePending).mockResolvedValue(false);

    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'owned', jobId: 'j9' });
    expect(repository.removeStalePending).toHaveBeenCalledWith('claim-1', new Date(now.getTime() - 60_000));
    expect(repository.insertPending).toHaveBeenCalledTimes(1);
  });

  it('AC-5: retries insertion after stale removal', async () => {
    vi.mocked(repository.insertPending).mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 'claim-2' }));
    vi.mocked(repository.findHead).mockResolvedValue(row({ createdAt: new Date(now.getTime() - 60_001) }));
    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'claimed', claimId: 'claim-2' });
  });
  it('AC-6: preserves failed outcome', async () => {
    vi.mocked(repository.insertPending).mockResolvedValue(null);
    vi.mocked(repository.findHead).mockResolvedValue(row({ outcome: 'failed:repo gone' }));
    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'failed', outcome: 'failed:repo gone' });
  });
  it('AC-7: lost insert with no visible row is busy', async () => {
    vi.mocked(repository.insertPending).mockResolvedValue(null);
    await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'busy' });
  });
  it('AC-8: markDispatched runs in bookkeeping', async () => {
    vi.mocked(repository.markDispatched).mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBe('fleet.pr-review-bookkeeping');
    });
    await service.markDispatched('claim-1', 'job-1');
    expect(repository.markDispatched).toHaveBeenCalledWith('claim-1', 'job-1');
  });
  it('AC-9: release runs in bookkeeping', async () => {
    vi.mocked(repository.remove).mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBe('fleet.pr-review-bookkeeping');
    });
    await service.release('claim-1');
    expect(repository.remove).toHaveBeenCalledWith('claim-1');
  });
  it('AC-10: service is provided by FleetReviewsModule', () => {
    expect(Reflect.getMetadata('providers', FleetReviewsModule)).toContain(FleetReviewClaimService);
  });
  it('AC-11: existing event service export remains', () => {
    expect(Reflect.getMetadata('exports', FleetReviewsModule)).toContain(FleetReviewEventsService);
  });

  /**
   * US-006: a stale pending claim whose dispatch pass already created a job. The job is adopted rather than
   * the claim dropped and the head dispatched a second time.
   */
  describe('stale claim recovery', () => {
    const staleCreatedAt = new Date(now.getTime() - 60_001);
    const staleRow = (overrides: Partial<FleetPrReviewRecord> = {}) => row({ createdAt: staleCreatedAt, ...overrides });

    beforeEach(() => {
      vi.mocked(repository.insertPending).mockResolvedValue(null);
      vi.mocked(repository.findHead).mockResolvedValue(staleRow());
    });

    it('US-006 AC-4a: owns the job found inside the stale claim window', async () => {
      jobs.findReviewJobIdBetween.mockResolvedValue('job-1');
      vi.mocked(repository.markDispatchedIfPending).mockResolvedValue(true);

      await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'owned', jobId: 'job-1' });
      expect(jobs.findReviewJobIdBetween).toHaveBeenCalledWith('repo-1', 12, staleCreatedAt, new Date(staleCreatedAt.getTime() + 60_000));
      expect(repository.markDispatchedIfPending).toHaveBeenCalledWith('claim-1', 'job-1');
    });

    it('US-006 AC-4b: never drops the claim when it linked a job', async () => {
      jobs.findReviewJobIdBetween.mockResolvedValue('job-1');
      vi.mocked(repository.markDispatchedIfPending).mockResolvedValue(true);

      await service.claimHead('repo-1', 12, 'h1', now);

      expect(repository.removeStalePending).not.toHaveBeenCalled();
      expect(repository.insertPending).toHaveBeenCalledTimes(1);
    });

    it('US-006 AC-5: reports the job the lost link left on the claim', async () => {
      jobs.findReviewJobIdBetween.mockResolvedValue('job-1');
      vi.mocked(repository.markDispatchedIfPending).mockResolvedValue(false);
      vi.mocked(repository.findHead)
        .mockResolvedValueOnce(staleRow())
        .mockResolvedValueOnce(row({ outcome: 'dispatched', jobId: 'job-2' }));

      await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'owned', jobId: 'job-2' });
    });

    it('US-006 AC-6: removes and retries the claim when no job matches', async () => {
      jobs.findReviewJobIdBetween.mockResolvedValue(null);
      vi.mocked(repository.insertPending).mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 'claim-2' }));

      await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'claimed', claimId: 'claim-2' });
      expect(jobs.findReviewJobIdBetween).toHaveBeenCalledTimes(1);
      expect(repository.removeStalePending).toHaveBeenCalledWith('claim-1', new Date(now.getTime() - 60_000));
      expect(repository.markDispatchedIfPending).not.toHaveBeenCalled();
    });

    it('US-006 AC-7a: reports busy when the job lookup fails', async () => {
      jobs.findReviewJobIdBetween.mockRejectedValue(new Error('lookup boom'));

      await expect(service.claimHead('repo-1', 12, 'h1', now)).resolves.toEqual({ kind: 'busy' });
      expect(jobs.findReviewJobIdBetween).toHaveBeenCalledTimes(1);
      // No retry insert either: the claim was left exactly as it was for this pass.
      expect(repository.insertPending).toHaveBeenCalledTimes(1);
    });

    it('US-006 AC-7b: leaves the claim as it is when the job lookup fails', async () => {
      jobs.findReviewJobIdBetween.mockRejectedValue(new Error('lookup boom'));

      await service.claimHead('repo-1', 12, 'h1', now);

      expect(repository.removeStalePending).not.toHaveBeenCalled();
      expect(repository.markDispatchedIfPending).not.toHaveBeenCalled();
    });

    it('US-006 AC-8: runs the conditional link in fleet.pr-review-bookkeeping', async () => {
      jobs.findReviewJobIdBetween.mockResolvedValue('job-1');
      let reason: string | undefined;
      vi.mocked(repository.markDispatchedIfPending).mockImplementation(async () => {
        reason = currentBookkeepingReason();
        return true;
      });

      await service.claimHead('repo-1', 12, 'h1', now);

      expect(reason).toBe('fleet.pr-review-bookkeeping');
    });
  });
});
