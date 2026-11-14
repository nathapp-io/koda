import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const START = new Date('2026-11-09T12:30:00.000Z');
const POLL_MS = 120_000;
const open = {
  number: 31, state: 'open' as const, draft: false, merged: false, mergedAt: null,
  mergedBy: null, mergeSha: null, url: 'https://github.com/o/r/pull/31', title: 'feature',
};
const feature = {
  id: 'feature-a', flowId: 'flow-a', position: 0, feature: 'a', specPath: '.nax/features/a/spec.md',
  dependsOn: [], state: 'READY' as const, currentStep: null, prNumber: 31,
};
const flow = (features = [feature]): FleetFlowRecord => ({
  id: 'flow-a', projectId: 'p1', repoId: 'repo-a', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/a', specSha: 'a'.repeat(40), setSha: 'a'.repeat(40),
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000', spentUsd: '0.0000',
  state: 'WAITING_MERGE', approvalMode: 'REQUEST', approverId: 'u1', approvedAt: START,
  approvalRequestId: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: START, updatedAt: START,
  features: features.length === 0 ? [] : [...features, {
    id: 'feature-next', flowId: 'flow-a', position: 1, feature: 'next', specPath: '.nax/features/next/spec.md',
    dependsOn: ['a'], state: 'PENDING' as const, currentStep: null, prNumber: null,
  }],
});

function setup(options: { rows?: FleetFlowRecord[]; getPullRequest?: () => Promise<typeof open> } = {}) {
  const rows = options.rows ?? [flow()];
  let rowIndex = 0;
  let inTransaction = false;
  const flows = {
    findById: vi.fn(async () => rows[Math.min(rowIndex++, rows.length - 1)] ?? null),
    lockById: vi.fn(async () => rows[0] ?? null), stop: vi.fn(),
  };
  const steps = {
    latestJobWithIngest: vi.fn(), latestJobForStep: vi.fn(), countJobsForStepSince: vi.fn(),
    sumCost: vi.fn(async () => '0.0000'), setSpent: vi.fn(), complete: vi.fn(), markStep: vi.fn(),
    creatorAccess: vi.fn(), setBranch: vi.fn(), setFeatureBranch: vi.fn(), markFeatureState: vi.fn(),
    setFlowState: vi.fn(), recordCalls: vi.fn(), recordPrdEdits: vi.fn(), recordRulings: vi.fn(),
    setWaiting: vi.fn(), projectSlug: vi.fn(async () => 'web'),
  };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  }) };
  const repos = {
    lockById: vi.fn(async () => ({ id: 'repo-a' })),
    findReviewRepo: vi.fn(async () => ({ id: 'repo-a', owner: 'o', name: 'r', defaultBranch: 'main', githubInstallationId: 1n })),
  };
  const github = {
    mintThreadReadToken: vi.fn(async () => ({ token: 'token', expiresAt: START })),
    getPullRequest: vi.fn(options.getPullRequest ?? (async () => open)),
  };
  const activity = { record: vi.fn() };
  const audit = { record: vi.fn() };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, {} as never, repos as never, activity as never, audit as never,
    txManager as never, {} as never, {} as never, {} as never, github as never,
    {} as never, testFleetConfig({ flowMergePollMs: POLL_MS }), {} as never, {} as never, {} as never,
  );
  return { service, github, inTransaction: () => inTransaction };
}

describe('FleetFlowAdvanceService merge-watch polling interval', () => {
  it('AC-4: throttles successful watches until the interval boundary', async () => {
    const h = setup();
    await h.service.advance('flow-a', START);
    await h.service.advance('flow-a', new Date(START.getTime() + POLL_MS - 1));
    expect(h.github.getPullRequest).toHaveBeenCalledTimes(1);
  });

  it('AC-5: watches again exactly at the interval boundary', async () => {
    const h = setup();
    await h.service.advance('flow-a', START);
    await h.service.advance('flow-a', new Date(START.getTime() + POLL_MS));
    expect(h.github.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('AC-6: a thrown non-forge watch is retried on the next advance', async () => {
    const getPullRequest = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(open);
    const h = setup({ getPullRequest });
    await expect(h.service.advance('flow-a', START)).rejects.toThrow('boom');
    await h.service.advance('flow-a', new Date(START.getTime() + 1));
    expect(getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('AC-7: successful timestamps are scoped to the flow', async () => {
    const secondFlow = flow();
    secondFlow.id = 'flow-b';
    secondFlow.features = secondFlow.features.map((item) => ({ ...item, flowId: 'flow-b' }));
    const h = setup({ rows: [flow(), secondFlow] });
    await h.service.advance('flow-a', START);
    await h.service.advance('flow-b', new Date(START.getTime() + 1));
    expect(h.github.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('AC-9: retry outcomes do not record a successful-watch timestamp', async () => {
    const getPullRequest = vi.fn().mockRejectedValueOnce(new RepoCheckException('provider_unreachable')).mockResolvedValue(open);
    const h = setup({ getPullRequest });
    await h.service.advance('flow-a', START);
    await h.service.advance('flow-a', new Date(START.getTime() + 1));
    expect(getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('AC-10: an idle watch does not throttle a subsequent awaited PR', async () => {
    const getPullRequest = vi.fn().mockResolvedValue(open);
    const h = setup({ rows: [flow([]), flow()] , getPullRequest });
    await h.service.advance('flow-a', START);
    await h.service.advance('flow-a', new Date(START.getTime() + 1));
    expect(getPullRequest).toHaveBeenCalledWith('token', 'o', 'r', 31);
    expect(getPullRequest).toHaveBeenCalledTimes(1);
  });
});
