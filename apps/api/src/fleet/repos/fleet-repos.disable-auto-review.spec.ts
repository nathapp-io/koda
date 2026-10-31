import { FleetReposService } from './fleet-repos.service';

describe('FleetReposService.disableAutoReview', () => {
  let repo: { disableAutoReviewIf: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
  let tx: { run: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };

  const service = () => new FleetReposService(
    repo as never, {} as never, {} as never, {} as never, {} as never, tx as never,
    audit as never, {} as never,
  );
  const disable = (reason = 'enabler_lost_access') => service().disableAutoReview('r1', reason, 'u1');

  beforeEach(() => {
    repo = {
      disableAutoReviewIf: vi.fn().mockResolvedValue(true),
      findById: vi.fn().mockResolvedValue({ id: 'r1', projectId: 'p1', autoReview: false }),
    };
    tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
  });

  it('AC-12: records the turn-off audit entry when the compare-and-set changed the row', async () => {
    await disable();
    expect(repo.disableAutoReviewIf).toHaveBeenCalledWith('r1', 'u1');
    expect(audit.record).toHaveBeenCalledWith({
      key: 'system.pr-review.dispatch',
      resourceType: 'fleet-repo',
      resourceId: 'r1',
      projectId: 'p1',
      summary: 'auto-review disabled: enabler_lost_access',
    });
  });

  it('AC-13: answers what the compare-and-set answered', async () => {
    expect(await disable()).toBe(true);
    repo.disableAutoReviewIf.mockResolvedValue(false);
    expect(await disable()).toBe(false);
  });

  it('AC-14: records no audit entry when nothing changed', async () => {
    repo.disableAutoReviewIf.mockResolvedValue(false);
    expect(await disable()).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('runs the claim and its audit in one transaction, in that order', async () => {
    const events: string[] = [];
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { events.push('begin'); const value = await fn(); events.push('end'); return value; });
    repo.disableAutoReviewIf.mockImplementation(async () => { events.push('claim'); return true; });
    audit.record.mockImplementation(async () => { events.push('audit'); });
    await disable();
    expect(events).toEqual(['begin', 'claim', 'audit', 'end']);
  });
});
