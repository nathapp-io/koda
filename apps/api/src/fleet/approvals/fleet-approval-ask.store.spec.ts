import type { IPageOption } from '@nathapp/nestjs-common';
import type { ApprovalFilters, ApprovalResolvedBy, FleetApprovalRecord, PendingCount, RequeueCandidate } from './domain/approval.domain';
import type {
  FleetAskWithStatus, FleetApprovalAskRecord, IFleetApprovalAskRepository, NewFleetApprovalAsk,
} from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

const record = (over: Partial<FleetApprovalAskRecord> = {}): FleetApprovalAskRecord => ({
  requestId: 'req-1', kind: 'bash', projectId: 'project-1', jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-1',
  budgetPolicyId: null, resolvedBy: null, outcome: null, createdAt: new Date(1), updatedAt: new Date(2), ...over,
});

/** The fleet view of one ask, as the read methods answer it. */
const view = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'req-1', type: 'nax_bash_escalate', status: 'pending', projectId: 'project-1', jobId: 'job-1', leaseEpoch: 2,
  naxAskId: 'ask-1', policyId: null, payload: {}, outcome: null, requestedAt: new Date(1), expiresAt: new Date(2),
  decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: new Date(1),
  updatedAt: new Date(2), ...over,
});

function mockRepository() {
  return {
    insert: vi.fn(async (_data: NewFleetApprovalAsk) => record()),
    findByRequest: vi.fn(async (_requestId: string) => record()),
    findByAsk: vi.fn(async (_jobId: string, _leaseEpoch: number, _naxAskId: string): Promise<FleetAskWithStatus | null> =>
      ({ ask: record(), status: 'pending' })),
    lockByRequest: vi.fn(async (_requestId: string) => record()),
    findPendingForJob: vi.fn(async (_jobId: string) => [record()]),
    findPendingForJobPage: vi.fn(async (_jobId: string, _after?: string, _limit?: number) => [record()]),
    findEndedJobPendingAsks: vi.fn(async (_limit: number) => ['job-1']),
    findPendingForPolicy: vi.fn(async (_budgetPolicyId: string) => record()),
    setResolvedBy: vi.fn(async (_requestId: string, _resolvedBy: ApprovalResolvedBy) => record({ resolvedBy: 'job_ended' })),
    setOutcome: vi.fn(async (_requestId: string, _outcome: Record<string, unknown>) => record({ outcome: { requeueResults: [] } })),
    findApproval: vi.fn(async (_requestId: string) => view()),
    findPage: vi.fn(async (_f: ApprovalFilters, _page: IPageOption) => ({
      records: [view()], total: 1, current: 1, size: 10, hasNext: false, hasPrev: false,
    })),
    countPending: vi.fn(async (_projectIds: readonly string[]): Promise<PendingCount[]> => [{ projectId: 'project-1', slug: 'web', pending: 2 }]),
    countPendingAllProjects: vi.fn(async (): Promise<PendingCount[]> => [{ projectId: 'project-1', slug: 'web', pending: 2 }]),
    countPendingUnscoped: vi.fn(async () => 1),
    countPendingByJob: vi.fn(async (_jobIds: readonly string[]) => new Map([['job-1', 2]])),
    findRequeueCandidates: vi.fn(async (_policyId: string, _since: Date, _limit: number): Promise<RequeueCandidate[]> =>
      [{ jobId: 'job-1', projectId: 'project-1', feature: 'f', queuedAt: new Date(1) }]),
    findProjectSlug: vi.fn(async (_projectId: string) => 'web'),
  } satisfies IFleetApprovalAskRepository;
}

describe('FleetApprovalAskStore', () => {
  it('delegates every repository call with its arguments and returns the repository answer', async () => {
    const repository = mockRepository();
    const store = new FleetApprovalAskStore(repository);
    const created = { requestId: 'req-1', kind: 'bash' as const, projectId: 'project-1', jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-1' };

    expect(await store.insert(created)).toEqual(record());
    expect(repository.insert).toHaveBeenCalledWith(created);
    expect(await store.findByRequest('req-1')).toEqual(record());
    expect(repository.findByRequest).toHaveBeenCalledWith('req-1');
    expect(await store.findByAsk('job-1', 2, 'ask-1')).toEqual({ ask: record(), status: 'pending' });
    expect(repository.findByAsk).toHaveBeenCalledWith('job-1', 2, 'ask-1');
    expect(await store.lockByRequest('req-1')).toEqual(record());
    expect(repository.lockByRequest).toHaveBeenCalledWith('req-1');
    expect(await store.findPendingForJob('job-1')).toEqual([record()]);
    expect(repository.findPendingForJob).toHaveBeenCalledWith('job-1');
    expect(await store.findPendingForJobPage('job-1', 'req-1')).toEqual([record()]);
    expect(repository.findPendingForJobPage).toHaveBeenCalledWith('job-1', 'req-1', undefined);
    expect(await store.findEndedJobPendingAsks(10)).toEqual(['job-1']);
    expect(repository.findEndedJobPendingAsks).toHaveBeenCalledWith(10);
    expect(await store.findPendingForPolicy('policy-1')).toEqual(record());
    expect(repository.findPendingForPolicy).toHaveBeenCalledWith('policy-1');
    expect(await store.setResolvedBy('req-1', 'job_ended')).toEqual(record({ resolvedBy: 'job_ended' }));
    expect(repository.setResolvedBy).toHaveBeenCalledWith('req-1', 'job_ended');
    expect(await store.setOutcome('req-1', { requeueResults: [] })).toEqual(record({ outcome: { requeueResults: [] } }));
    expect(repository.setOutcome).toHaveBeenCalledWith('req-1', { requeueResults: [] });
  });

  it('delegates the eight read methods the fleet projection needs, with their arguments', async () => {
    const repository = mockRepository();
    const store = new FleetApprovalAskStore(repository);
    const page = { current: 1, size: 10 };
    const since = new Date(1);

    expect(await store.findApproval('req-1')).toEqual(view());
    expect(repository.findApproval).toHaveBeenCalledWith('req-1');
    expect(await store.findPage({ status: 'approved' }, page)).toEqual(expect.objectContaining({ records: [view()], total: 1 }));
    expect(repository.findPage).toHaveBeenCalledWith({ status: 'approved' }, page);
    expect(await store.countPending(['project-1'])).toEqual([{ projectId: 'project-1', slug: 'web', pending: 2 }]);
    expect(repository.countPending).toHaveBeenCalledWith(['project-1']);
    expect(await store.countPendingAllProjects()).toEqual([{ projectId: 'project-1', slug: 'web', pending: 2 }]);
    expect(repository.countPendingAllProjects).toHaveBeenCalledWith();
    expect(await store.countPendingUnscoped()).toBe(1);
    expect(repository.countPendingUnscoped).toHaveBeenCalledWith();
    expect(await store.countPendingByJob(['job-1'])).toEqual(new Map([['job-1', 2]]));
    expect(repository.countPendingByJob).toHaveBeenCalledWith(['job-1']);
    expect(await store.findRequeueCandidates('policy-1', since, 10)).toHaveLength(1);
    expect(repository.findRequeueCandidates).toHaveBeenCalledWith('policy-1', since, 10);
    expect(await store.findProjectSlug('project-1')).toBe('web');
    expect(repository.findProjectSlug).toHaveBeenCalledWith('project-1');
  });
});
