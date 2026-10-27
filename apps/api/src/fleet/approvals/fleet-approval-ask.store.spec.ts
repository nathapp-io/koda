import type { ApprovalResolvedBy } from './domain/approval.domain';
import type {
  FleetAskWithStatus, FleetApprovalAskRecord, IFleetApprovalAskRepository, NewFleetApprovalAsk,
} from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

const record = (over: Partial<FleetApprovalAskRecord> = {}): FleetApprovalAskRecord => ({
  requestId: 'req-1', kind: 'bash', projectId: 'project-1', jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-1',
  budgetPolicyId: null, resolvedBy: null, outcome: null, createdAt: new Date(1), updatedAt: new Date(2), ...over,
});

function mockRepository() {
  return {
    insert: vi.fn(async (_data: NewFleetApprovalAsk) => record()),
    findByRequest: vi.fn(async (_requestId: string) => record()),
    findByAsk: vi.fn(async (_jobId: string, _leaseEpoch: number, _naxAskId: string): Promise<FleetAskWithStatus | null> =>
      ({ ask: record(), status: 'pending' })),
    lockByRequest: vi.fn(async (_requestId: string) => record()),
    findPendingForJob: vi.fn(async (_jobId: string) => [record()]),
    findPendingForPolicy: vi.fn(async (_budgetPolicyId: string) => record()),
    setResolvedBy: vi.fn(async (_requestId: string, _resolvedBy: ApprovalResolvedBy) => record({ resolvedBy: 'job_ended' })),
    setOutcome: vi.fn(async (_requestId: string, _outcome: Record<string, unknown>) => record({ outcome: { requeueResults: [] } })),
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
    expect(await store.findPendingForPolicy('policy-1')).toEqual(record());
    expect(repository.findPendingForPolicy).toHaveBeenCalledWith('policy-1');
    expect(await store.setResolvedBy('req-1', 'job_ended')).toEqual(record({ resolvedBy: 'job_ended' }));
    expect(repository.setResolvedBy).toHaveBeenCalledWith('req-1', 'job_ended');
    expect(await store.setOutcome('req-1', { requeueResults: [] })).toEqual(record({ outcome: { requeueResults: [] } }));
    expect(repository.setOutcome).toHaveBeenCalledWith('req-1', { requeueResults: [] });
  });
});
