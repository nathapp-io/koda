import type { AuditRecordInput } from '../../audit/audit-recorder.service';
import type { FleetPrReviewRecord } from './domain/fleet-pr-review.domain';
import { buildFixFollowUpPayload } from '../common/fix-follow-up-events';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { FixFollowUpSubscriber } from './fix-follow-up.subscriber';

const payload = buildFixFollowUpPayload({
  id: 'fix-1', projectId: 'p1', repoId: 'r1', requestedById: 'u1', requestedByType: 'USER',
  leaseEpoch: 1, profiles: ['balanced'], maxCostUsd: '1.00',
} as FleetJobRecord, 22, 'a'.repeat(40));
const claim: FleetPrReviewRecord = {
  id: 'claim-1', repoId: 'r1', prNumber: 22, headSha: 'a'.repeat(40), jobId: null,
  outcome: 'pending', createdAt: new Date(0), updatedAt: new Date(0),
};

function setup() {
  const reviews = {
    findPrincipalAccess: vi.fn(async () => ({ exists: true, disabled: false })),
    insertPending: vi.fn(async (): Promise<FleetPrReviewRecord | null> => claim),
    markDispatched: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined), findHead: vi.fn(async () => null),
  };
  const repos = { findReviewRepo: vi.fn(async () => ({ id: 'r1', projectId: 'p1', owner: 'o', name: 'n', githubInstallationId: 1n })) };
  const permissions = { effectiveKeys: vi.fn(async () => new Set(['fleet.job.dispatch'])) };
  const jobs = { dispatch: vi.fn(async () => ({ job: { id: 'review-1' } })) };
  const audits: AuditRecordInput[] = [];
  const audit = { record: vi.fn(async (input: AuditRecordInput) => { audits.push(input); }) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) };
  const subscriber = new FixFollowUpSubscriber({ register: vi.fn() } as never, reviews, jobs as never, repos as never,
    permissions as never, audit as never, txManager as never);
  return { subscriber, reviews, repos, permissions, jobs, audit, audits, txManager };
}

describe('FixFollowUpSubscriber skips', () => {
  it.each([
    ['missing dispatch key', async (h: ReturnType<typeof setup>) => { h.permissions.effectiveKeys.mockResolvedValue(new Set()); }],
    ['disabled requester', async (h: ReturnType<typeof setup>) => { h.reviews.findPrincipalAccess.mockResolvedValue({ exists: true, disabled: true }); }],
    ['missing requester', async (h: ReturnType<typeof setup>) => { h.reviews.findPrincipalAccess.mockResolvedValue({ exists: false, disabled: false }); }],
  ])('does not claim when requester has lost access: %s', async (_label, configure) => {
    const h = setup(); await configure(h);
    await h.subscriber.handle(payload);
    expect(h.reviews.insertPending).not.toHaveBeenCalled();
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.audits[0]).toMatchObject({ resourceId: 'fix-1', summary: 'follow-up review skipped: requester_lost_access' });
  });

  it('skips a missing repo before claiming and audits the FIX job', async () => {
    const h = setup(); h.repos.findReviewRepo.mockResolvedValue(null);
    await h.subscriber.handle(payload);
    expect(h.reviews.insertPending).not.toHaveBeenCalled();
    expect(h.audits[0]).toMatchObject({ resourceId: 'fix-1', summary: 'follow-up review skipped: repo_gone' });
  });

  it('audits an already claimed head without dispatching', async () => {
    const h = setup(); h.reviews.insertPending.mockResolvedValue(null);
    await h.subscriber.handle(payload);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
    expect(h.audits[0]).toMatchObject({ resourceId: 'fix-1', summary: 'follow-up review skipped: head_already_claimed' });
  });

  it('propagates a failed skip audit write', async () => {
    const h = setup(); h.reviews.insertPending.mockResolvedValue(null); h.audit.record.mockRejectedValue(new Error('db down'));
    await expect(h.subscriber.handle(payload)).rejects.toThrow('db down');
  });

  it.each([
    ['findPrincipalAccess', async (h: ReturnType<typeof setup>) => h.reviews.findPrincipalAccess.mockRejectedValue(new Error('db down'))],
    ['effectiveKeys', async (h: ReturnType<typeof setup>) => h.permissions.effectiveKeys.mockRejectedValue(new Error('db down'))],
    ['findReviewRepo', async (h: ReturnType<typeof setup>) => h.repos.findReviewRepo.mockRejectedValue(new Error('db down'))],
    ['insertPending after repo deletion', async (h: ReturnType<typeof setup>) => h.reviews.insertPending.mockRejectedValue(new Error('db down'))],
  ])('propagates database failures from %s', async (_label, reject) => {
    const h = setup(); await reject(h);
    await expect(h.subscriber.handle(payload)).rejects.toThrow('db down');
  });

  it.each([
    ['requester_lost_access', async (h: ReturnType<typeof setup>) => { h.reviews.findPrincipalAccess.mockResolvedValue({ exists: false, disabled: false }); }],
    ['repo_gone', async (h: ReturnType<typeof setup>) => { h.repos.findReviewRepo.mockResolvedValue(null); }],
  ])('propagates audit failures for %s', async (_reason, configure) => {
    const h = setup(); await configure(h); h.audit.record.mockRejectedValue(new Error('db down'));
    await expect(h.subscriber.handle(payload)).rejects.toThrow('db down');
  });
});
