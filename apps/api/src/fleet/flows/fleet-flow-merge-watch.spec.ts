import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { ForgeFile } from '../git-broker/forge-tree';
import type { RepoCheckReason } from '../git-broker/repo-check.exception';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { VcsPrStatus } from '../../vcs/types';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * US-012: the merge watch of a flow that waits for a merge. The pass polls the awaited PRs outside
 * any transaction, records the merges under the flow locks, resumes the flow when the next feature
 * can start and stops it when a PR was closed. Every case drives `FleetFlowAdvanceService.advance`.
 */
const NOW = new Date('2026-11-09T12:30:00.000Z');
const APPROVED_AT = new Date('2026-11-09T12:00:00.000Z');
const SPEC_A = '.nax/features/a/spec.md';
const SPEC_B = '.nax/features/b/spec.md';
const SPEC_C = '.nax/features/c/spec.md';
const SET_SHA = 'a'.repeat(40);
const DEFAULT_HEAD = 'd'.repeat(40);

const specFile = (sha = 'blob-1'): ForgeFile => ({ sha, size: 12, content: Buffer.from('# spec') });

const featureA = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-a', flowId: 'flow-1', position: 0, feature: 'a', specPath: SPEC_A,
  dependsOn: [], state: 'READY', currentStep: null, prNumber: 31, ...over,
});

const featureB = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-b', flowId: 'flow-1', position: 1, feature: 'b', specPath: SPEC_B,
  dependsOn: [], state: 'READY', currentStep: null, prNumber: 32, ...over,
});

const featureC = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-c', flowId: 'flow-1', position: 2, feature: 'c', specPath: SPEC_C,
  dependsOn: ['a'], state: 'PENDING', currentStep: null, prNumber: null, ...over,
});

/** A flow that waits for the merge of its first feature. */
const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/a', specSha: SET_SHA, setSha: SET_SHA,
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'WAITING_MERGE', approvalMode: 'REQUEST', approverId: 'u1',
  approvedAt: APPROVED_AT, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT,
  features: [featureA(), featureC()], ...over,
});

/** A flow that waits for two merges: the third feature depends on both of them. */
const twoAwaited = (over: Partial<FleetFlowRecord> = {}): Partial<FleetFlowRecord> => ({
  features: [featureA(), featureB(), featureC({ dependsOn: ['a', 'b'] })],
  ...over,
});

const openPr = (number: number): VcsPrStatus => ({
  number, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null,
  mergeSha: null, url: `https://github.com/o/r/pull/${number}`, title: `feature ${number}`,
});
const mergedPr = (number: number): VcsPrStatus => ({
  ...openPr(number), state: 'closed', merged: true, mergedAt: NOW,
});
const closedPr = (number: number): VcsPrStatus => ({ ...openPr(number), state: 'closed' });

interface Options {
  /** The rows `findById` returns, one per call; the last one repeats. */
  rows?: FleetFlowRecord[];
  /** The rows `lockById` returns, one per call; the last one repeats. */
  lockedRows?: FleetFlowRecord[];
  /** The repo's installation; null is a repo that is not connected to a forge. */
  installationId?: bigint | null;
  /** The PR status per PR number; a number without an entry is an open PR. */
  prs?: Record<number, VcsPrStatus | null>;
  /** The forge call that fails, and why. */
  forgeError?: { call: 'mint' | 'pullRequest'; reason: RepoCheckReason };
  /** The spec blob per ref; a ref without an entry has no file. */
  files?: Record<string, ForgeFile | null>;
}

function build(opts: Options = {}) {
  const row = flow();
  const rows = opts.rows ?? [row];
  // The locked row is the row that was read, unless the test moves the flow meanwhile.
  const locked = opts.lockedRows ?? rows;
  let rowIndex = 0;
  let lockIndex = 0;
  const prs = new Map<number, VcsPrStatus | null>(Object.entries(opts.prs ?? {}).map(([key, value]) => [Number(key), value]));
  const files = new Map<string, ForgeFile | null>(Object.entries(opts.files ?? {}));
  let inTransaction = false;
  const assertTx = () => { expect(inTransaction).toBe(true); };
  const assertNoTx = () => { expect(inTransaction).toBe(false); };
  const failForge = (call: NonNullable<Options['forgeError']>['call']): void => {
    if (opts.forgeError?.call === call) throw new RepoCheckException(opts.forgeError.reason);
  };
  const flows = {
    findById: vi.fn(async () => rows[Math.min(rowIndex++, rows.length - 1)] ?? null),
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
    effectiveKeys: vi.fn(async () => { assertTx(); return new Set(['fleet.job.dispatch']); }),
  };
  const flowService = { reaskLocked: vi.fn(async () => { assertTx(); return row; }) };
  const github = {
    mintThreadReadToken: vi.fn(async () => {
      assertNoTx(); failForge('mint'); return { token: 'read-token', expiresAt: NOW };
    }),
    mintInstallationToken: vi.fn(async () => {
      assertNoTx(); return { token: 'write-token', expiresAt: NOW };
    }),
    mintReadOnlyToken: vi.fn(async () => { assertNoTx(); return { token: 'read-only', expiresAt: NOW }; }),
    getPullRequest: vi.fn(async (_token: string, _owner: string, _name: string, number: number) => {
      assertNoTx();
      failForge('pullRequest');
      return prs.has(number) ? (prs.get(number) ?? null) : openPr(number);
    }),
    getBranchHead: vi.fn(async () => { assertNoTx(); return DEFAULT_HEAD; }),
    getFile: vi.fn(async (_token: string, _owner: string, _name: string, _path: string, ref: string) => {
      assertNoTx(); return files.get(ref) ?? null;
    }),
    createBranch: vi.fn(async () => { assertNoTx(); return { kind: 'created' as const }; }),
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

describe('FleetFlowAdvanceService.advance, the merge watch', () => {
  it('AC-3: a waiting flow polls the awaited PR with a read token', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(1n, 'r');
    expect(h.github.getPullRequest).toHaveBeenCalledExactlyOnceWith('read-token', 'o', 'r', 31);
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-4: a merged PR marks the feature MERGED and resumes the flow', async () => {
    const h = build({ prs: { 31: mergedPr(31) } });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markFeatureState).toHaveBeenCalledExactlyOnceWith('feature-a', 'MERGED');
    expect(h.steps.setFlowState).toHaveBeenCalledExactlyOnceWith('flow-1', 'RUNNING');
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'flow.resumed',
      entityType: 'flow',
      entityId: 'flow-1',
      payload: { merged: ['a'] },
    }));
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-5: an open PR changes nothing and the flow keeps waiting', async () => {
    const h = build({ prs: { 31: openPr(31) } });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.steps.setFlowState).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-6: a PR closed without merge stops the flow', async () => {
    const h = build({ prs: { 31: closedPr(31) } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'pr_closed', NOW, 'PR #31 closed without merge');
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    // A stop carries the activity, the audit entry and the outbox event every other stop carries.
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'flow.stopped',
      entityId: 'flow-1',
    }));
    expect(h.audit.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      key: 'system.flow.advance',
      resourceId: 'flow-1',
    }));
    expect(h.outbox.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'fleet_flow_stopped',
    }));
  });

  it('AC-7: a PR that is gone stops the flow', async () => {
    const h = build({ prs: { 31: null } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'pr_closed', NOW, 'PR #31 not found');
  });

  it.each(['provider_error', 'provider_unreachable'] as const)(
    'AC-8: a %s from the PR read ends the pass with no write',
    async (reason) => {
      const h = build({ forgeError: { call: 'pullRequest', reason } });

      await h.service.advance('flow-1', NOW);

      expect(h.flows.stop).not.toHaveBeenCalled();
      expect(h.steps.markFeatureState).not.toHaveBeenCalled();
      expect(h.steps.setFlowState).not.toHaveBeenCalled();
      expect(h.activity.record).not.toHaveBeenCalled();
    },
  );

  it('AC-8: a provider_error from the token mint ends the pass with no write', async () => {
    const h = build({ forgeError: { call: 'mint', reason: 'provider_error' } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.steps.setFlowState).not.toHaveBeenCalled();
  });

  const permanentReasons = ['app_not_installed', 'app_permissions_insufficient', 'repo_not_found'] as const;

  it.each(permanentReasons)('AC-9: a %s from the PR read stops the flow', async (reason) => {
    const h = build({ forgeError: { call: 'pullRequest', reason } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, reason);
    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
  });

  it.each(permanentReasons)('AC-9: a %s from the token mint stops the flow', async (reason) => {
    const h = build({ forgeError: { call: 'mint', reason } });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, reason);
    expect(h.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('AC-10: a repo without an installation stops the flow before any forge call', async () => {
    const h = build({ installationId: null });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'repo not connected');
    expect(h.github.mintThreadReadToken).not.toHaveBeenCalled();
    expect(h.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('AC-11: an awaited feature without a PR stops the flow', async () => {
    const h = build({ rows: [flow({ features: [featureA({ prNumber: null }), featureC()] })] });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'dispatch_refused', NOW, 'feature a has no PR');
    expect(h.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('AC-12: one merged and one open PR mark the merged feature and keep the flow waiting', async () => {
    const h = build({ rows: [flow(twoAwaited())], prs: { 31: mergedPr(31), 32: openPr(32) } });

    await h.service.advance('flow-1', NOW);

    expect(h.github.getPullRequest).toHaveBeenCalledTimes(2);
    expect(h.steps.markFeatureState).toHaveBeenCalledExactlyOnceWith('feature-a', 'MERGED');
    expect(h.steps.setFlowState).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-13: a waiting flow dispatches no job, and the next pass starts the next feature', async () => {
    const merged = flow({ features: [featureA({ state: 'MERGED' }), featureC()], state: 'RUNNING' });
    const h = build({
      rows: [flow(), merged],
      lockedRows: [flow(), merged, merged],
      prs: { 31: mergedPr(31) },
      files: { [DEFAULT_HEAD]: specFile(), [SET_SHA]: specFile() },
    });

    await h.service.advance('flow-1', NOW);
    expect(h.jobs.dispatch).not.toHaveBeenCalled();

    await h.service.advance('flow-1', NOW);

    expect(h.github.createBranch).toHaveBeenCalledExactlyOnceWith('write-token', 'o', 'r', 'feat/c', DEFAULT_HEAD);
    expect(h.steps.setFeatureBranch).toHaveBeenCalledExactlyOnceWith('feature-c', 'feat/c');
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-14: a flow that stopped meanwhile records nothing', async () => {
    const h = build({
      rows: [flow(twoAwaited())],
      lockedRows: [flow({ state: 'STOPPED', features: [featureA(), featureB(), featureC({ dependsOn: ['a', 'b'] })] })],
      prs: { 31: mergedPr(31), 32: closedPr(32) },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.steps.setFlowState).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('AC-14: a flow that still waits records the merge and the stop', async () => {
    const h = build({
      rows: [flow(twoAwaited())],
      prs: { 31: mergedPr(31), 32: closedPr(32) },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markFeatureState).toHaveBeenCalledExactlyOnceWith('feature-a', 'MERGED');
    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'pr_closed', NOW, 'PR #32 closed without merge');
    expect(h.steps.setFlowState).not.toHaveBeenCalled();
  });

  it('AC-14: an approval that changed at the record re-read records nothing', async () => {
    const h = build({
      rows: [flow(twoAwaited())],
      lockedRows: [flow({ approvedAt: new Date('2026-11-09T12:10:00.000Z'), features: [featureA(), featureB(), featureC({ dependsOn: ['a', 'b'] })] })],
      prs: { 31: mergedPr(31), 32: closedPr(32) },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.steps.markFeatureState).not.toHaveBeenCalled();
    expect(h.flows.stop).not.toHaveBeenCalled();
  });
});
