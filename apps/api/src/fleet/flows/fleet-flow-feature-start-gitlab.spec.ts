import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { ForgeFile } from '../git-broker/forge-tree';
import type { RepoCheckReason } from '../git-broker/repo-check.exception';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const NOW = new Date('2026-11-09T12:30:00.000Z');
const SET_SHA = 'a'.repeat(40);
const DEFAULT_HEAD = 'd'.repeat(40);
const SPEC_B = '.nax/features/b/spec.md';
const specFile = (sha = 'blob-1'): ForgeFile => ({ sha, size: 12, content: Buffer.from('# spec') });
const feature = (position: number, name: string, state: 'READY' | 'PENDING' | 'MERGED' = 'PENDING', dependsOn: string[] = []): FleetFlowFeatureRecord => ({
  id: `feature-${name}`, flowId: 'flow-1', position, feature: name, specPath: `.nax/features/${name}/spec.md`,
  dependsOn, state, currentStep: null, prNumber: null,
});
const flow = (features: FleetFlowFeatureRecord[]): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/a', specSha: SET_SHA, setSha: SET_SHA,
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000', spentUsd: '0.0000',
  state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1', approvedAt: NOW, approvalRequestId: null,
  stopReason: null, stopDetail: null, endedAt: null, createdAt: NOW, updatedAt: NOW, features,
});
interface Options {
  files?: Record<string, ForgeFile | null>;
  branch?: { kind: 'created' } | { kind: 'exists'; sha: string } | { kind: 'refused' };
  repo?: { provider: string; githubInstallationId: bigint | null };
  gitlabError?: { call: 'read' | 'write'; reason: RepoCheckReason };
}
function build(opts: Options = {}) {
  const row = flow([feature(0, 'a', 'MERGED'), feature(1, 'b', 'PENDING', ['a'])]);
  const files = new Map<string, ForgeFile | null>(Object.entries(opts.files ?? {}));
  let inTx = false;
  const assertTx = () => expect(inTx).toBe(true);
  const assertNoTx = () => expect(inTx).toBe(false);
  const fail = (call: 'read' | 'write') => { if (opts.gitlabError?.call === call) throw new RepoCheckException(opts.gitlabError.reason); };
  const flows = { findById: vi.fn(async () => row), lockById: vi.fn(async () => { assertTx(); return row; }), stop: vi.fn(async () => { assertTx(); return row; }) };
  const steps = {
    latestJobWithIngest: vi.fn(async () => null), latestJobForStep: vi.fn(async () => null), countJobsForStepSince: vi.fn(async () => 0),
    sumCost: vi.fn(async () => row.spentUsd), setSpent: vi.fn(async () => undefined), complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }), creatorAccess: vi.fn(async () => { assertTx(); return { exists: true, disabled: false }; }),
    setBranch: vi.fn(async () => { assertTx(); }), setFeatureBranch: vi.fn(async () => { assertTx(); }), markFeatureState: vi.fn(async () => { assertTx(); }),
    setFlowState: vi.fn(async () => { assertTx(); }), recordCalls: vi.fn(async () => { assertTx(); }), recordPrdEdits: vi.fn(async () => { assertTx(); }),
    recordRulings: vi.fn(async () => { assertTx(); }), setWaiting: vi.fn(async () => { assertTx(); }), projectSlug: vi.fn(async () => 'web'),
  };
  const repos = {
    lockById: vi.fn(async () => { assertTx(); return { id: row.repoId }; }),
    findReviewRepo: vi.fn(async () => ({ id: row.repoId, owner: 'o', name: 'r', defaultBranch: 'main', ...opts.repo ?? { provider: 'gitlab', githubInstallationId: null } })),
  };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => { assertNoTx(); inTx = true; try { return await fn(); } finally { inTx = false; } }) };
  const gitlabCredentials = { call: vi.fn(async (_repo: unknown, kind: 'read' | 'write', fn: (access: { token: string }) => Promise<unknown>) => {
    assertNoTx(); if (kind === 'read') fail(kind); return fn({ token: 'gitlab-token' });
  }) };
  const gitlab = {
    getBranchHead: vi.fn(async () => { assertNoTx(); return DEFAULT_HEAD; }),
    getFile: vi.fn(async (_access: unknown, _path: string, ref: string) => { assertNoTx(); return files.get(ref) ?? null; }),
    createBranch: vi.fn(async () => { assertNoTx(); return opts.branch ?? { kind: 'created' as const }; }),
  };
  const github = {
    mintInstallationToken: vi.fn(async () => { assertNoTx(); return { token: 'github-token', expiresAt: NOW }; }),
    mintReadOnlyToken: vi.fn(async () => ({ token: 'read-token', expiresAt: NOW })),
    getBranchHead: vi.fn(), getFile: vi.fn(), createBranch: vi.fn(),
  };
  const activity = { record: vi.fn(async () => { assertTx(); }) };
  const audit = { record: vi.fn(async () => { assertTx(); }) };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, { lockForFlowTransition: vi.fn() } as never, repos as never, activity as never, audit as never,
    txManager as never, { dispatch: vi.fn() } as never, { effectiveKeys: vi.fn(async () => { assertTx(); return new Set(['fleet.job.dispatch']); }) } as never,
    { reaskLocked: vi.fn() } as never, github as never,
    { claimHead: vi.fn(), markDispatched: vi.fn(), release: vi.fn() } as never, testFleetConfig(),
    { apply: vi.fn(), applyPrdEdits: vi.fn() } as never, { record: vi.fn() } as never,
    { ruledItemIds: vi.fn(async () => []), createForFlow: vi.fn(), commentRefused: vi.fn() } as never,
    gitlabCredentials as never, gitlab as never,
  );
  return { service, flows, steps, repos, txManager, gitlabCredentials, gitlab, github, activity, audit };
}

describe('FleetFlowAdvanceService.advance starting a GitLab feature', () => {
  it('AC-1: uses read credentials to compare approved spec and write credentials to create feat/b', async () => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() } });
    await h.service.advance('flow-1', NOW);
    expect(h.gitlabCredentials.call).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: 'gitlab' }), 'read', expect.any(Function));
    expect(h.gitlab.getBranchHead).toHaveBeenCalledWith({ token: 'gitlab-token' }, 'main');
    expect(h.gitlab.getFile).toHaveBeenCalledTimes(2);
    expect(h.gitlabCredentials.call.mock.calls.map(([, kind]) => kind)).toEqual(['read', 'read', 'read', 'write']);
    expect(h.gitlab.createBranch).toHaveBeenCalledWith({ token: 'gitlab-token' }, 'feat/b', DEFAULT_HEAD);
    expect(h.steps.setFeatureBranch).toHaveBeenCalledWith('feature-b', 'feat/b');
    expect(h.steps.markFeatureState).toHaveBeenCalledWith('feature-b', 'RUNNING');
  });
  it('AC-2: records a branch already present at the default head', async () => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() }, branch: { kind: 'exists', sha: DEFAULT_HEAD } });
    await h.service.advance('flow-1', NOW);
    expect(h.steps.setFeatureBranch).toHaveBeenCalledWith('feature-b', 'feat/b');
  });
  it('AC-3: refuses an existing branch at another head', async () => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() }, branch: { kind: 'exists', sha: 'elsewhere' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'branch feat/b already exists');
  });
  it('AC-4: refuses when branch creation is refused', async () => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() }, branch: { kind: 'refused' } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'branch feat/b not created');
  });
  it('AC-5: stops on a changed spec without creating a branch', async () => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile('base'), [SET_SHA]: specFile('set') } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'spec_changed', NOW, `${SPEC_B} differs from the approved spec`);
    expect(h.gitlab.createBranch).not.toHaveBeenCalled();
  });
  it.each(['gitlab_credentials_missing', 'gitlab_token_invalid'] as const)('AC-6/AC-9: stops on %s credentials failure', async (reason) => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() }, gitlabError: { call: 'read', reason } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, reason);
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
  });
  it.each(['provider_error', 'gitlab_host_blocked'] as const)('AC-7: retries %s, then starts once fixed', async (reason) => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() } });
    h.gitlab.createBranch.mockRejectedValueOnce(new RepoCheckException(reason));
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
    h.gitlab.createBranch.mockResolvedValue({ kind: 'created' });
    await h.service.advance('flow-1', new Date(NOW.getTime() + 1));
    expect(h.steps.setFeatureBranch).toHaveBeenCalledWith('feature-b', 'feat/b');
  });
  it('AC-8: ignores a GitHub installation id on a GitLab row', async () => {
    const h = build({ repo: { provider: 'gitlab', githubInstallationId: 9n }, files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() } });
    await h.service.advance('flow-1', NOW);
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.gitlab.createBranch).toHaveBeenCalled();
  });
  it.each(['gitlab_host_invalid', 'gitlab_host_unclassified', 'vcs_encryption_key_missing'] as const)('AC-10: retries %s without flow writes or stop', async (reason) => {
    const h = build({ files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() }, gitlabError: { call: 'read', reason } });
    await h.service.advance('flow-1', NOW);
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
  });
});
