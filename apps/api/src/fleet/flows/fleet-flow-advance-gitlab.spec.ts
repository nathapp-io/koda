import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { callsOutcomeForForgeError } from './flow-calls';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const NOW = new Date('2026-11-17T12:30:00.000Z');
const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'app', specPath: '.nax/features/app/spec.md',
  dependsOn: [], state: 'READY', currentStep: null, prNumber: 12, ...over,
});
const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/app', specSha: 'spec-sha', setSha: 'spec-sha',
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'WAITING_MERGE', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: NOW, approvalRequestId: null, stopReason: null, stopDetail: null, endedAt: null,
  createdAt: NOW, updatedAt: NOW, features: [feature(), feature({ id: 'feature-2', position: 1, feature: 'next', state: 'PENDING', prNumber: null, dependsOn: ['app'] })], ...over,
});

function build(options: { state?: FleetFlowRecord['state']; merged?: boolean; status?: string; nullPr?: boolean; error?: string; provider?: string; latestJob?: Record<string, unknown>; features?: FleetFlowFeatureRecord[] } = {}) {
  const row = flow({ state: options.state ?? 'WAITING_MERGE', ...(options.features ? { features: options.features } : {}) });
  let inTransaction = false;
  const flows = {
    findById: vi.fn(async () => row), lockById: vi.fn(async () => row),
    stop: vi.fn(async () => row),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => options.latestJob ? { job: options.latestJob, ingestSettled: true } : null), latestJobForStep: vi.fn(async () => null),
    countJobsForStepSince: vi.fn(async () => 0), sumCost: vi.fn(async () => '0.0000'),
    creatorAccess: vi.fn(async () => ({ exists: true, disabled: false })),
    markFeatureState: vi.fn(async () => undefined), setFlowState: vi.fn(async () => undefined),
    setSpent: vi.fn(async () => undefined), complete: vi.fn(async () => undefined), markStep: vi.fn(async () => undefined),
  };
  const repo = { id: 'repo-1', owner: 'grp', name: 'app', host: 'https://gitlab.com', provider: options.provider ?? 'gitlab', defaultBranch: 'main', githubInstallationId: null };
  const repos = { lockById: vi.fn(async () => repo), findReviewRepo: vi.fn(async () => repo) };
  const gitlab = {
    getBranchHead: vi.fn(async () => 'head'),
    getMergeRequest: vi.fn(async () => {
      if (options.error) throw new RepoCheckException(options.error as never);
      if (options.nullPr) return null;
      return { number: 12, merged: options.merged ?? false, state: options.status ?? 'open' };
    }),
  };
  const gitlabCredentials = { call: vi.fn(async (_repo: unknown, _kind: string, fn: (a: { token: string }) => Promise<unknown>) => {
    if (options.error === 'gitlab_credentials_missing' || options.error === 'gitlab_token_invalid') throw new RepoCheckException(options.error);
    return fn({ token: 'access-token' });
  }) };
  const github = {
    mintThreadReadToken: vi.fn(async () => ({ token: 'github-read', expiresAt: NOW })),
    mintReadOnlyToken: vi.fn(async () => ({ token: 'github-read', expiresAt: NOW })),
    mintInstallationToken: vi.fn(async () => ({ token: 'github-write', expiresAt: NOW })),
    getPullRequest: vi.fn(async () => null), getBranchHead: vi.fn(async () => 'head'), getFile: vi.fn(async () => null),
  };
  const activity = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const outbox = { record: vi.fn(async () => undefined) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    inTransaction = true; try { return await fn(); } finally { inTransaction = false; }
  }) };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, {} as never, repos as never, activity as never, audit as never,
    txManager as never, { dispatch: vi.fn(async () => ({ job: { id: 'review-job' } })), adoptForFlow: vi.fn(async () => true) } as never,
    { effectiveKeys: vi.fn(async () => new Set(['fleet.job.dispatch'])) } as never,
    { reaskLocked: vi.fn() } as never, github as never,
    { claimHead: vi.fn(async () => ({ kind: 'claimed', claimId: 'claim' })), markDispatched: vi.fn(), release: vi.fn() } as never,
    testFleetConfig(), { apply: vi.fn(), applyPrdEdits: vi.fn() } as never, outbox as never,
    { ruledItemIds: vi.fn(async () => []), createForFlow: vi.fn(), commentRefused: vi.fn() } as never,
    gitlabCredentials as never, gitlab as never,
  );
  return { service, flows, steps, repos, activity, audit, outbox, gitlab, gitlabCredentials, github, repo, inTransaction: () => inTransaction };
}

describe('GitLab flow advance', () => {
  it('AC-1: approved-flow spec-head preflight uses GitLab credentials, never GitHub', async () => {
    const h = build({ state: 'APPROVED', features: [feature({ state: 'PENDING' })] });
    await h.service.advance('flow-1', NOW);
    expect(h.gitlabCredentials.call).toHaveBeenCalledWith(h.repo, 'read', expect.any(Function));
    expect(h.gitlab.getBranchHead).toHaveBeenCalledWith({ token: 'access-token' }, 'feat/app');
    expect(h.github.mintReadOnlyToken).not.toHaveBeenCalled();
  });

  it('AC-2: a failed GitLab spec-head preflight does not stop or write the flow', async () => {
    const h = build({ state: 'APPROVED', features: [feature({ state: 'PENDING' })], error: 'gitlab_token_invalid' });
    h.gitlab.getBranchHead.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.steps.setFlowState).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('AC-3: reads awaited merge requests with per-call GitLab credentials, never GitHub', async () => {
    const h = build();
    await h.service.advance('flow-1', NOW);
    expect(h.repos.findReviewRepo).toHaveBeenCalled();
    expect(h.gitlabCredentials.call).toHaveBeenCalledWith(h.repo, 'read', expect.any(Function));
    expect(h.gitlab.getMergeRequest).toHaveBeenCalledWith({ token: 'access-token' }, 12);
    expect(h.github.mintThreadReadToken).not.toHaveBeenCalled();
  });

  it('AC-4: records a merged merge request', async () => {
    const h = build({ merged: true });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.markFeatureState).toHaveBeenCalledWith('feature-1', 'MERGED');
  });

  it.each([{ status: 'closed' }, { nullPr: true }])('AC-5/6: stops for a closed or missing merge request', async (result) => {
    const h = build(result);
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'pr_closed', NOW, expect.any(String));
  });

  it.each(['gitlab_token_invalid', 'gitlab_credentials_missing'] as const)('AC-7/13: stops on %s', async (reason) => {
    const h = build({ error: reason });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, reason);
  });

  it.each(['provider_error', 'gitlab_host_blocked', 'vcs_encryption_key_missing', 'gitlab_host_invalid', 'gitlab_host_unclassified'] as const)(
    'AC-8/14: %s retries without writing progress', async (reason) => {
      const h = build({ error: reason });
      await h.service.advance('flow-1', NOW);
      expect(h.flows.stop).not.toHaveBeenCalled();
      expect(h.steps.markFeatureState).not.toHaveBeenCalled();
      expect(h.steps.setFlowState).not.toHaveBeenCalled();
      expect(h.activity.record).not.toHaveBeenCalled();
      expect(h.audit.record).not.toHaveBeenCalled();
      expect(h.outbox.record).not.toHaveBeenCalled();
      expect(h.gitlab.getMergeRequest).toHaveBeenCalled();
    },
  );

  it('AC-12: attributes a GitLab RUN merge-request URL to the REVIEW step', async () => {
    const completedRun = {
      id: 'run-job', flowStep: 'RUN', state: 'COMPLETED', stateReason: null,
      queuedAt: new Date(NOW.getTime() - 60_000), finishedAt: NOW,
      resultPrUrl: 'https://gitlab.com/grp/app/-/merge_requests/7', resultSha: 'review-head',
      resultBranch: 'feat/app', feature: 'app', agentResult: null, fixReady: null,
    };
    const h = build({
      state: 'RUNNING', features: [feature({ state: 'RUNNING', currentStep: 'RUN', prNumber: null })],
      latestJob: completedRun,
    });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.markStep).toHaveBeenCalledWith('flow-1', 'feature-1', 'REVIEW', {
      flowState: 'RUNNING', prNumber: 7,
    });
  });

  it('AC-9/10/11: classifies GitLab credential and host failures', () => {
    expect(callsOutcomeForForgeError('gitlab_credentials_missing')).toBe('failed');
    expect(callsOutcomeForForgeError('gitlab_token_invalid')).toBe('failed');
    expect(callsOutcomeForForgeError('gitlab_host_blocked')).toBe('retry');
  });
});
