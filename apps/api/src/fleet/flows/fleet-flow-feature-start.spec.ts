import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { ForgeFile } from '../git-broker/forge-tree';
import type { RepoCheckReason } from '../git-broker/repo-check.exception';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * US-011: a later feature starts on its own branch. The start pass creates `feat/<feature>` outside
 * any transaction, refuses a spec that is no longer the approved one, and records the branch under
 * the flow locks. Every case drives `FleetFlowAdvanceService.advance`.
 */
const NOW = new Date('2026-11-09T12:30:00.000Z');
const APPROVED_AT = new Date('2026-11-09T12:00:00.000Z');
const SPEC_A = '.nax/features/a/spec.md';
const SPEC_B = '.nax/features/b/spec.md';
const SET_SHA = 'a'.repeat(40);
const DEFAULT_HEAD = 'd'.repeat(40);

const specFile = (sha = 'blob-1'): ForgeFile => ({ sha, size: 12, content: Buffer.from('# spec') });

const featureA = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-a', flowId: 'flow-1', position: 0, feature: 'a', specPath: SPEC_A,
  dependsOn: [], state: 'READY', currentStep: null, prNumber: null, ...over,
});

const featureB = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-b', flowId: 'flow-1', position: 1, feature: 'b', specPath: SPEC_B,
  dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/a', specSha: SET_SHA, setSha: SET_SHA,
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT,
  features: [featureA(), featureB()], ...over,
});

/** A flow whose second feature waits for the first one's merge: it starts at the default branch. */
const defaultBase = (): Partial<FleetFlowRecord> => ({
  features: [featureA({ state: 'MERGED' }), featureB({ dependsOn: ['a'] })],
});

interface Options {
  flow?: Partial<FleetFlowRecord>;
  /** The rows `lockById` returns, one per call; the last one repeats. */
  lockedRows?: FleetFlowRecord[];
  /** The repo's installation; null is a repo that is not connected to a forge. */
  installationId?: bigint | null;
  /** The spec blob per ref; a ref without an entry has no file. */
  files?: Record<string, ForgeFile | null>;
  /** What `createBranch` answers. */
  branch?: { kind: 'created' } | { kind: 'exists'; sha: string } | { kind: 'refused' };
  /** The forge call that fails, and why. */
  forgeError?: { call: 'mint' | 'branchHead' | 'file' | 'createBranch'; reason: RepoCheckReason };
  /** The keys the flow's creator holds. */
  creatorKeys?: string[];
}

function build(opts: Options = {}) {
  const row = flow({ ...opts.flow });
  const locked = opts.lockedRows ?? [row];
  let lockIndex = 0;
  const files = new Map<string, ForgeFile | null>(Object.entries(opts.files ?? {}));
  let inTransaction = false;
  const assertTx = () => { expect(inTransaction).toBe(true); };
  const assertNoTx = () => { expect(inTransaction).toBe(false); };
  const failForge = (call: NonNullable<Options['forgeError']>['call']): void => {
    if (opts.forgeError?.call === call) throw new RepoCheckException(opts.forgeError.reason);
  };
  const flows = {
    findById: vi.fn(async () => row),
    lockById: vi.fn(async () => {
      assertTx();
      return locked[Math.min(lockIndex++, locked.length - 1)] ?? null;
    }),
    stop: vi.fn(async () => { assertTx(); return row; }),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => null),
    latestJobForStep: vi.fn(async () => null),
    countJobsForStepSince: vi.fn(async () => 0),
    sumCost: vi.fn(async () => row.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }),
    creatorAccess: vi.fn(async () => { assertTx(); return { exists: true, disabled: false }; }),
    setBranch: vi.fn(async () => { assertTx(); }),
    setFeatureBranch: vi.fn(async () => { assertTx(); }),
    markFeatureState: vi.fn(async () => { assertTx(); }),
    setFlowState: vi.fn(async () => { assertTx(); }),
    recordCalls: vi.fn(async () => { assertTx(); }),
    recordPrdEdits: vi.fn(async () => { assertTx(); }),
    recordRulings: vi.fn(async () => { assertTx(); }),
    setWaiting: vi.fn(async () => { assertTx(); }),
    projectSlug: vi.fn(async () => 'web'),
  };
  const repos = {
    lockById: vi.fn(async () => { assertTx(); return { id: row.repoId }; }),
    findReviewRepo: vi.fn(async () => ({
      id: row.repoId, owner: 'o', name: 'r', defaultBranch: 'main',
      githubInstallationId: opts.installationId === undefined ? 1n : opts.installationId,
    })),
  };
  const threads = { lockForFlowTransition: vi.fn(async () => { assertTx(); return { publishedSha: null }; }) };
  const activity = { record: vi.fn(async () => { assertTx(); }) };
  const audit = { record: vi.fn(async () => { assertTx(); }) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    assertNoTx();
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  }) };
  const jobs = { dispatch: vi.fn(async () => { assertNoTx(); return { job: { id: 'next-job' } }; }) };
  const permissions = {
    effectiveKeys: vi.fn(async () => { assertTx(); return new Set(opts.creatorKeys ?? ['fleet.job.dispatch']); }),
  };
  const flowService = { reaskLocked: vi.fn(async () => { assertTx(); return row; }) };
  const github = {
    mintInstallationToken: vi.fn(async () => {
      assertNoTx(); failForge('mint'); return { token: 'test-only', expiresAt: NOW };
    }),
    mintReadOnlyToken: vi.fn(async () => { assertNoTx(); return { token: 'read-only', expiresAt: NOW }; }),
    getBranchHead: vi.fn(async () => { assertNoTx(); failForge('branchHead'); return DEFAULT_HEAD; }),
    getFile: vi.fn(async (_token: string, _owner: string, _name: string, _path: string, ref: string) => {
      assertNoTx(); failForge('file'); return files.get(ref) ?? null;
    }),
    createBranch: vi.fn(async () => {
      assertNoTx(); failForge('createBranch'); return opts.branch ?? { kind: 'created' as const };
    }),
  };
  const calls = { apply: vi.fn(), applyPrdEdits: vi.fn() };
  const outbox = { record: vi.fn(async () => { assertTx(); }) };
  const rulings = {
    ruledItemIds: vi.fn(async () => []),
    createForFlow: vi.fn(async () => ({ kind: 'recorded' as const, rulingId: 'ruling-1' })),
    commentRefused: vi.fn(async () => { assertTx(); }),
  };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never, activity as never, audit as never,
    txManager as never, jobs as never, permissions as never, flowService as never, github as never,
    { claimHead: vi.fn(), markDispatched: vi.fn(), release: vi.fn() } as never, testFleetConfig(),
    calls as never, outbox as never, rulings as never,
  );
  return { service, row, flows, steps, repos, threads, activity, audit, txManager, jobs, permissions,
    flowService, github, calls, outbox, rulings, files };
}

describe('FleetFlowAdvanceService.advance, the start of a later feature', () => {
  it('AC-1: a start with base spec mints one token and creates feat/b at the set sha', async () => {
    const h = build({ files: { [SET_SHA]: specFile() } });

    await h.service.advance('flow-1', NOW);

    expect(h.github.mintInstallationToken).toHaveBeenCalledExactlyOnceWith(1n, 'r');
    expect(h.github.getFile).toHaveBeenCalledWith('test-only', 'o', 'r', SPEC_B, SET_SHA);
    expect(h.github.getBranchHead).not.toHaveBeenCalled();
    expect(h.github.createBranch).toHaveBeenCalledExactlyOnceWith('test-only', 'o', 'r', 'feat/b', SET_SHA);
  });

  it('AC-2: a start with base default creates feat/b at the default branch head', async () => {
    const h = build({
      flow: defaultBase(),
      files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.github.getBranchHead).toHaveBeenCalledExactlyOnceWith('test-only', 'o', 'r', 'main');
    expect(h.github.createBranch).toHaveBeenCalledExactlyOnceWith('test-only', 'o', 'r', 'feat/b', DEFAULT_HEAD);
  });

  it('AC-3: a spec that differs from the approved one stops the flow', async () => {
    const h = build({
      flow: defaultBase(),
      files: { [DEFAULT_HEAD]: specFile('blob-base'), [SET_SHA]: specFile('blob-set') },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith(
      'flow-1', 'spec_changed', NOW, '.nax/features/b/spec.md differs from the approved spec',
    );
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-4: a spec missing at the base stops the flow', async () => {
    const h = build({
      flow: defaultBase(),
      files: { [DEFAULT_HEAD]: null, [SET_SHA]: specFile() },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith(
      'flow-1', 'spec_changed', NOW, '.nax/features/b/spec.md differs from the approved spec',
    );
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-5: a spec missing at the set sha stops the flow', async () => {
    const h = build({
      flow: defaultBase(),
      files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: null },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith(
      'flow-1', 'spec_changed', NOW, '.nax/features/b/spec.md differs from the approved spec',
    );
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-4/AC-5: a spec missing at the set sha of a spec-based start stops the flow', async () => {
    const h = build({ files: {} });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith(
      'flow-1', 'spec_changed', NOW, '.nax/features/b/spec.md differs from the approved spec',
    );
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-6: a created branch is recorded under the locks', async () => {
    const h = build({ files: { [SET_SHA]: specFile() } });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setFeatureBranch).toHaveBeenCalledExactlyOnceWith('feature-b', 'feat/b');
    expect(h.steps.markFeatureState).toHaveBeenCalledExactlyOnceWith('feature-b', 'RUNNING');
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'flow.feature_started',
      entityId: 'flow-1',
      payload: { feature: 'b', base: 'spec', sha: SET_SHA, branch: 'feat/b' },
    }));
    expect(h.flows.stop).not.toHaveBeenCalled();
    // The set review of the first feature is preserved: the start moves no spec sha.
    expect(h.steps.recordCalls).not.toHaveBeenCalled();
  });

  it('AC-7: an existing branch at the base sha is treated as created', async () => {
    const h = build({ files: { [SET_SHA]: specFile() }, branch: { kind: 'exists', sha: SET_SHA } });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setFeatureBranch).toHaveBeenCalledExactlyOnceWith('feature-b', 'feat/b');
    expect(h.steps.markFeatureState).toHaveBeenCalledExactlyOnceWith('feature-b', 'RUNNING');
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'flow.feature_started',
      payload: { feature: 'b', base: 'spec', sha: SET_SHA, branch: 'feat/b' },
    }));
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-8: an existing branch at another sha stops the flow', async () => {
    const h = build({ files: { [SET_SHA]: specFile() }, branch: { kind: 'exists', sha: 'other-sha' } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'branch feat/b already exists');
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
  });

  it('AC-9: a refused branch stops the flow', async () => {
    const h = build({ files: { [SET_SHA]: specFile() }, branch: { kind: 'refused' } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'branch feat/b not created');
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
  });

  it('AC-10: a thread-entry flow stops before any forge call', async () => {
    const h = build({ flow: { threadId: 'thread-1' }, files: { [SET_SHA]: specFile() } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'thread entry runs one feature');
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.github.getFile).not.toHaveBeenCalled();
    expect(h.github.getBranchHead).not.toHaveBeenCalled();
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  const forgeCalls = ['mint', 'branchHead', 'file', 'createBranch'] as const;

  it.each(forgeCalls)('AC-11: a provider_error from %s ends the pass with no write and no stop', async (call) => {
    const h = build({
      flow: defaultBase(),
      files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() },
      forgeError: { call, reason: 'provider_error' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  const permanentReasons = ['app_not_installed', 'app_permissions_insufficient', 'repo_not_found'] as const;

  it.each(permanentReasons)('AC-12: a %s from createBranch stops the flow', async (reason) => {
    const h = build({
      files: { [SET_SHA]: specFile() },
      forgeError: { call: 'createBranch', reason },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, reason);
    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
  });

  it('AC-12: a permanent reason from a read of the spec stops the flow', async () => {
    const h = build({
      flow: defaultBase(),
      files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() },
      forgeError: { call: 'file', reason: 'app_permissions_insufficient' },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'app_permissions_insufficient');
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-13: a repo without an installation stops the flow before any forge call', async () => {
    const h = build({ installationId: null, files: { [SET_SHA]: specFile() } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'repo not connected');
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-14: a creator without dispatch access stops the flow before any forge call', async () => {
    const h = build({ creatorKeys: [], files: { [SET_SHA]: specFile() } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith(
      'flow-1', 'creator_lost_access', NOW, 'flow creator lost dispatch access',
    );
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.github.createBranch).not.toHaveBeenCalled();
  });

  it('AC-15: a flow that stopped at the record re-read records nothing', async () => {
    const h = build({
      files: { [SET_SHA]: specFile() },
      lockedRows: [flow(), flow({ state: 'STOPPED' })],
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('AC-15: a feature that already started at the record re-read records nothing', async () => {
    const h = build({
      files: { [SET_SHA]: specFile() },
      lockedRows: [flow(), flow({ features: [featureA(), featureB({ state: 'RUNNING' })] })],
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('AC-15: an approval that changed at the record re-read records nothing', async () => {
    const h = build({
      files: { [SET_SHA]: specFile() },
      lockedRows: [flow(), flow({ approvedAt: new Date('2026-11-09T12:10:00.000Z') })],
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.setFeatureBranch).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });
});
