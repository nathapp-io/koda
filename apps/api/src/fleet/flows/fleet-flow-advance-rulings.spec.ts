import type { FleetJobRecord, FleetJobWorkflowItem } from '../jobs/domain/fleet-job.domain';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { CreatorAccess } from './domain/fleet-flow-step.domain';
import type { PermissionService } from '../../permissions/permission.service';
import type { FleetPrRuling, IFleetPrRulingRepository, NewFleetPrRuling } from '../rulings/fleet-pr-ruling.domain';
import { FleetPrRulingsService, NAX_ITEM_INDEX_MARKER, type FlowRulingInput, type FlowRulingOutcome } from '../rulings/fleet-pr-rulings.service';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { isWellFormedFlowText } from './flow-calls';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * US-010: the RULE verdict's rulings leave the decide transaction. Every ruling owns its own
 * transaction, a ruling that is not in the RULE task is refused, and the flow records the rulings
 * it wrote, the ones it refused, and where it refused them.
 */
const NOW = new Date('2026-11-07T12:30:00Z');
const APPROVED_AT = new Date('2026-11-07T12:00:00Z');
const RULE_JOB = 'rule-1';
const RUN_JOB = 'run-1';
const FINDING = { id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' } as const;

const OPEN_ITEMS: FleetJobWorkflowItem[] = [
  { id: 'D-1', kind: 'advisor', issue: 'Dep says 12', severity: null, file: null, line: null, suggestion: null },
  { id: 'S-1', kind: 'story', issue: 'Story is out of scope', severity: null, file: null, line: null, suggestion: null },
  { id: 'C-1', kind: 'advisor', issue: 'The advisor item', severity: null, file: null, line: null, suggestion: null },
  { id: 'F-1', kind: 'finding', issue: 'Missing AC', severity: null, file: null, line: null, suggestion: null },
];

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: '.nax/features/f/spec.md',
  dependsOn: [], state: 'RUNNING', currentStep: 'RULE', prNumber: 12, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: 'feat/f', specSha: 's1',
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'REQUEST', approverId: 'approver-1',
  approvedAt: APPROVED_AT, approvalRequestId: 'approval-1', stopReason: null, stopDetail: null,
  endedAt: null, createdAt: APPROVED_AT, updatedAt: APPROVED_AT, features: [feature()], ...over,
});

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: RULE_JOB, projectId: 'p1', repoId: 'repo-1', ref: 's1', command: 'AGENT', feature: 'f',
  planFrom: null, profiles: [], maxCostUsd: '5.0000', bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: 'runner-1', runnerBootId: 'boot-1', leaseEpoch: 2,
  state: 'COMPLETED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date('2026-11-07T12:05:00Z'), assignedAt: null, startedAt: null,
  finishedAt: new Date('2026-11-07T12:20:00Z'), cancelRequestedAt: null,
  naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: '0.0000', costCarriedUsd: '0.0000', firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: 0, resultBranch: 'feat/f', resultSha: 'review-sha',
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null,
  configResult: null, fixReady: null, flowId: 'flow-1', flowStep: 'RULE', threadId: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW,
  agentResult: { status: 'completed', output: JSON.stringify({ findings: [FINDING] }) }, ...over,
} as FleetJobRecord);

const runJob = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => job({
  id: RUN_JOB, command: 'RUN', flowStep: 'RUN', agentResult: null,
  workflow: { runId: 'nax-1', outcome: 'draft', workflowPassed: false, reasons: [], openItems: OPEN_ITEMS },
  ...over,
} as Partial<FleetJobRecord>);

interface Options {
  flow?: Partial<FleetFlowRecord>;
  latest?: Partial<FleetJobRecord>;
  /** The row each successive flow lock returns: index 0 the decide lock, index 1 the record lock. */
  locks?: Partial<FleetFlowRecord>[];
  /** The verdict the RULE job carries. */
  rulings?: { item: string; ruling: string }[];
  /** What the ruling writer answers for one ruling. */
  outcome?: (input: FlowRulingInput) => FlowRulingOutcome;
  /** The items a ruling already settled. */
  ruledItemIds?: string[];
  /** The RUN's open items: the RULE task lists these. */
  openItems?: FleetJobWorkflowItem[];
  creatorAccess?: CreatorAccess;
  creatorKeys?: ReadonlySet<string>;
  slug?: string | null;
  /** Write the rulings through the real ruling service instead of a stub. */
  realRulings?: boolean;
}

function build(opts: Options = {}) {
  const verdict = opts.rulings ?? [
    { item: 'D-1', ruling: 'verified: a' },
    { item: 'S-1', ruling: 'waive: out of scope' },
  ];
  const latest = job({
    ...opts.latest,
    agentResult: opts.latest?.agentResult
      ?? { status: 'completed', output: JSON.stringify({ rulings: verdict, questions: [] }) },
  });
  const row = flow({ features: [feature({ currentStep: latest.flowStep ?? null })], ...opts.flow });
  const run = runJob({
    workflow: {
      runId: 'nax-1', outcome: 'draft', workflowPassed: false, reasons: [],
      openItems: opts.openItems ?? OPEN_ITEMS,
    },
  });
  let inTransaction = false;
  let lockIndex = 0;
  const order: string[] = [];
  const assertTx = () => { expect(inTransaction).toBe(true); };
  const flows = {
    findById: vi.fn(async () => row),
    lockById: vi.fn(async () => {
      assertTx(); order.push('flow');
      return flow({ ...row, ...opts.locks?.[lockIndex++] });
    }),
    stop: vi.fn(async () => { assertTx(); return row; }),
  };
  const steps = {
    latestJobWithIngest: vi.fn(async () => ({ job: latest, ingestSettled: true })),
    sumCost: vi.fn(async () => row.spentUsd),
    setSpent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    markStep: vi.fn(async () => { assertTx(); }),
    creatorAccess: vi.fn(async (): Promise<CreatorAccess> => {
      assertTx(); return opts.creatorAccess ?? { exists: true, disabled: false };
    }),
    countJobsForStepSince: vi.fn(async () => 0),
    setBranch: vi.fn(async () => { assertTx(); }),
    recordCalls: vi.fn(async () => { assertTx(); }),
    recordRulings: vi.fn(async () => { assertTx(); }),
    setWaiting: vi.fn(async () => { assertTx(); }),
    latestJobForStep: vi.fn(async (_flowId: string, _featureId: string, step: string) => (step === 'RUN' ? run : null)),
    projectSlug: vi.fn(async () => (opts.slug === undefined ? 'web' : opts.slug)),
  };
  const repos = {
    lockById: vi.fn(async () => { assertTx(); order.push('repo'); return { id: row.repoId }; }),
    findReviewRepo: vi.fn(async () => ({ id: row.repoId, owner: 'o', name: 'r', githubInstallationId: 1n })),
  };
  const threads = { lockForFlowTransition: vi.fn(async () => { assertTx(); return { publishedSha: row.specSha }; }) };
  const activity = { record: vi.fn(async () => { assertTx(); }) };
  const audit = { record: vi.fn(async () => { assertTx(); }) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => {
    expect(inTransaction).toBe(false);
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  }) };
  const jobs = { dispatch: vi.fn(async () => {
    expect(inTransaction).toBe(false); return { job: { id: 'next-job' } };
  }) };
  const permissions = { effectiveKeys: vi.fn<PermissionService['effectiveKeys']>(async () => {
    assertTx(); return opts.creatorKeys ?? new Set(['fleet.job.dispatch']);
  }) };
  const flowService = { reaskLocked: vi.fn(async () => { assertTx(); return row; }) };
  const github = {
    mintReadOnlyToken: vi.fn(async () => { expect(inTransaction).toBe(false); return { token: 'test-only', expiresAt: NOW }; }),
    getBranchHead: vi.fn(async () => { expect(inTransaction).toBe(false); return row.specSha; }),
  };
  const calls = { apply: vi.fn(async () => {
    expect(inTransaction).toBe(false);
    return { kind: 'committed' as const, specSha: 's2' };
  }) };
  const outbox = { record: vi.fn(async () => { assertTx(); }) };
  // Whether a ruling was written outside the decide transaction.
  const inTransactionWhenRuling: boolean[] = [];
  const real = opts.realRulings === true ? realRulings(run.workflow?.openItems ?? OPEN_ITEMS) : null;
  const rulings = real === null ? {
    createForFlow: vi.fn(async (input: FlowRulingInput): Promise<FlowRulingOutcome> => {
      inTransactionWhenRuling.push(inTransaction);
      return opts.outcome ? opts.outcome(input) : { kind: 'recorded', rulingId: `ruling-${input.itemId}` };
    }),
    ruledItemIds: vi.fn(async () => opts.ruledItemIds ?? []),
    commentRefused: vi.fn(async (_runId: string, _body: string) => { assertTx(); }),
  } : {
    createForFlow: vi.fn(async (input: FlowRulingInput): Promise<FlowRulingOutcome> => {
      inTransactionWhenRuling.push(inTransaction);
      const outcome = await real.service.createForFlow(input);
      return opts.outcome ? opts.outcome(input) : outcome;
    }),
    ruledItemIds: vi.fn(async (runJobId: string) => real.service.ruledItemIds(runJobId)),
    commentRefused: vi.fn(async (runId: string, body: string) => { assertTx(); await real.service.commentRefused(runId, body); }),
  };
  const service = new FleetFlowAdvanceService(
    flows as never, steps as never, threads as never, repos as never, activity as never, audit as never,
    txManager as never, jobs as never, permissions as never, flowService as never, github as never,
    {} as never, testFleetConfig(), calls as never, outbox as never, rulings as never,
  );
  const wrote = () => [flows.stop, steps.setSpent, steps.complete, steps.markStep, steps.recordCalls,
    steps.recordRulings, steps.setWaiting, activity.record, audit.record, flowService.reaskLocked]
    .some((fn) => fn.mock.calls.length > 0);
  return { service, row, latest, run, flows, steps, rulings, activity, audit, jobs, permissions, calls,
    txManager, outbox, order, wrote, inTransactionWhenRuling, real };
}

/** The real ruling writer, so the flow's rulings are written through it. */
function realRulings(openItems: FleetJobWorkflowItem[]) {
  const rows: FleetPrRuling[] = [];
  const items = openItems.map(({ id, kind }) => ({ id, kind }));
  const repo: IFleetPrRulingRepository = {
    findTarget: vi.fn(async (projectId: string) => ({
      projectId, repoId: 'repo-1', command: 'RUN', outcome: 'draft', prNumber: 42, openItems: items,
      repo: { provider: 'github', owner: 'acme', name: 'app', githubInstallationId: 77n },
    })),
    lockTarget: vi.fn(async () => ({
      projectId: 'p1', repoId: 'repo-1', prNumber: 42, openItems: items,
      repo: { provider: 'github', owner: 'acme', name: 'app', githubInstallationId: 77n },
    })),
    latestRunForPr: vi.fn(async () => RUN_JOB),
    latestRuling: vi.fn(async (jobId: string, itemId: string) =>
      [...rows].reverse().find((row) => row.jobId === jobId && row.itemId === itemId) ?? null),
    list: vi.fn(async (jobId: string) => rows.filter((row) => row.jobId === jobId)),
    replacePending: vi.fn(async () => undefined),
    insert: vi.fn(async (data: NewFleetPrRuling) => {
      const row: FleetPrRuling = { ...data, id: `ruling-${rows.length + 1}`, createdAt: NOW, updatedAt: NOW };
      rows.push(row);
      return row;
    }),
    pendingForFix: vi.fn(async () => []),
    replaceOlderRuns: vi.fn(async () => undefined),
    settlePending: vi.fn(async () => null),
    runsForPr: vi.fn(async () => []),
  };
  /** The RUN's tickets: the refusal comment lands on each of them. */
  const tickets: { id: string; comments: string[] }[] = [];
  const effects = {
    ensureFinishTicket: vi.fn(async () => {
      if (!tickets.some((ticket) => ticket.id === 'ticket-1')) tickets.push({ id: 'ticket-1', comments: [] });
      return 'ticket-1';
    }),
    createSystemRulingComment: vi.fn(async (_ticketId: string, body: string) => {
      const ticket = tickets.find((entry) => entry.id === 'ticket-1');
      ticket?.comments.push(body);
      return { id: 'comment-1' };
    }),
    createRulingComment: vi.fn(async () => ({ id: 'comment-1' })),
    commentOnRulingResult: vi.fn(async (_runId: string, body: string) => {
      for (const ticket of tickets) ticket.comments.push(body);
    }),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const tx = {
    run: vi.fn(async <T>(fn: () => Promise<T>) => fn()), getClient: vi.fn(), isInTransaction: () => false,
  };
  const actors = { load: vi.fn(async () => ({ actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u@test.local' })) };
  const github = {
    mintThreadReadToken: vi.fn(async () => ({ token: 'ephemeral' })),
    listIssueComments: vi.fn(async () => [`published ${NAX_ITEM_INDEX_MARKER}`]),
  };
  const service = new FleetPrRulingsService(
    repo, tx as never, audit as never, effects as never, github as never, actors as never,
  );
  return { service, repo, effects, audit, tickets, rows };
}

describe('FleetFlowAdvanceService.advance, the RULE verdict', () => {
  it('AC-1: writes every in-task ruling once, in verdict order, under the flow identity', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.createForFlow).toHaveBeenCalledTimes(2);
    expect(h.rulings.createForFlow.mock.calls[0][0]).toEqual({
      projectId: 'p1', projectSlug: 'web', runJobId: RUN_JOB, itemId: 'D-1', text: 'verified: a',
      creator: { type: 'USER', id: 'u1' }, approvalRequestId: 'approval-1', flowId: 'flow-1',
    });
    expect(h.rulings.createForFlow.mock.calls[1][0]).toEqual({
      projectId: 'p1', projectSlug: 'web', runJobId: RUN_JOB, itemId: 'S-1', text: 'waive: out of scope',
      creator: { type: 'USER', id: 'u1' }, approvalRequestId: 'approval-1', flowId: 'flow-1',
    });
    expect(h.jobs.dispatch).not.toHaveBeenCalled();
  });

  it('AC-2: records the RULE job as the feature\'s recorded rulings', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.steps.recordRulings).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', RULE_JOB);
  });

  it('AC-3: never writes a ruling for an item the RULE task does not list', async () => {
    const h = build({ rulings: [{ item: 'F-1', ruling: 'verified: a' }, { item: 'D-1', ruling: 'verified: a' }] });

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.createForFlow).toHaveBeenCalledTimes(1);
    expect(h.rulings.createForFlow.mock.calls[0][0].itemId).toBe('D-1');
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.rulings',
      payload: expect.objectContaining({ refused: [{ item: 'F-1', reason: 'not in task' }] }),
    }));
  });

  it.each([
    ['a NUL', 'bad\u0000id', 'bad\uFFFDid'],
    ['a lone surrogate', 'bad\uD800id', 'bad\uFFFDid'],
  ])('AC-3: keeps the progress when a refused item id carries %s', async (_label, item, safe) => {
    const h = build({ rulings: [{ item: 'D-1', ruling: 'verified: a' }, { item, ruling: 'verified: b' }] });

    await h.service.advance('flow-1', NOW);

    // The flow records its progress: the refusal is reported, not retried forever.
    expect(h.steps.recordRulings).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', RULE_JOB);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.rulings',
      payload: expect.objectContaining({ recorded: ['D-1'], refused: [{ item: safe, reason: 'not in task' }] }),
    }));
    // The refused id lands in a JSONB payload and in a ticket comment: both reject what it carried.
    const payload = h.activity.record.mock.calls[0][0].payload;
    expect(isWellFormedFlowText(JSON.stringify(payload))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('\u0000');
    expect(h.rulings.commentRefused).toHaveBeenCalledExactlyOnceWith(
      RUN_JOB, `Flow rulings refused (RULE job rule-1): ${safe} (not in task)`,
    );
  });

  it('AC-4: keeps the ruling it wrote and reports the one it could not', async () => {
    const h = build({
      rulings: [{ item: 'D-1', ruling: 'verified: a' }, { item: 'C-1', ruling: 'verified: c' }],
      outcome: (input) => (input.itemId === 'C-1'
        ? { kind: 'refused', reason: 'fleet.rulings.notRulable' }
        : { kind: 'recorded', rulingId: 'ruling-1' }),
    });

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.createForFlow).toHaveBeenCalledTimes(2);
    expect(h.steps.recordRulings).toHaveBeenCalledExactlyOnceWith('flow-1', 'feature-1', RULE_JOB);
    expect(h.rulings.commentRefused).toHaveBeenCalledExactlyOnceWith(
      RUN_JOB,
      expect.stringContaining('Flow rulings refused (RULE job rule-1): C-1 (fleet.rulings.notRulable)'),
    );
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ recorded: ['D-1'], refused: [{ item: 'C-1', reason: 'fleet.rulings.notRulable' }] }),
    }));
  });

  it('AC-5: never comments on the tickets when no ruling was refused', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.commentRefused).not.toHaveBeenCalled();
  });

  it('AC-6: records one flow.rulings activity with the rulings it wrote and refused', async () => {
    const h = build({
      rulings: [{ item: 'D-1', ruling: 'verified: a' }, { item: 'C-1', ruling: 'verified: c' }],
      outcome: (input) => (input.itemId === 'C-1'
        ? { kind: 'refused', reason: 'fleet.rulings.notRulable' }
        : { kind: 'recorded', rulingId: 'ruling-1' }),
    });

    await h.service.advance('flow-1', NOW);

    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.rulings', entityType: 'flow', entityId: 'flow-1',
      projectId: 'p1',
      payload: {
        jobId: RULE_JOB,
        recorded: ['D-1'],
        refused: [{ item: 'C-1', reason: 'fleet.rulings.notRulable' }],
      },
    });
  });

  it('AC-7: records nothing when the flow is no longer live at the record transaction', async () => {
    const h = build({ locks: [{}, { state: 'STOPPED' }] });

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.createForFlow).toHaveBeenCalledTimes(2);
    expect(h.steps.recordRulings).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('AC-8: writes the rulings even when the flow spent its whole cap', async () => {
    const h = build({ flow: { spentUsd: '10.0000', costCapUsd: '10.0000' } });

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.createForFlow).toHaveBeenCalledTimes(2);
    expect(h.flows.stop).not.toHaveBeenCalled();
  });

  it('AC-9: stops the flow when the creator lost dispatch access', async () => {
    const h = build({ creatorKeys: new Set() });

    await h.service.advance('flow-1', NOW);

    expect(h.flows.stop).toHaveBeenCalledWith('flow-1', 'creator_lost_access', NOW, 'flow creator lost dispatch access');
    expect(h.rulings.createForFlow).not.toHaveBeenCalled();
  });

  it('AC-10: writes the rulings outside the decide transaction', async () => {
    const h = build();

    await h.service.advance('flow-1', NOW);

    expect(h.inTransactionWhenRuling).toEqual([false, false]);
  });

  it('AC-11: writes the last ruling of an item the verdict ruled twice', async () => {
    const h = build({
      rulings: [{ item: 'D-1', ruling: 'verified: a' }, { item: 'D-1', ruling: 'verified: b' }],
    });

    await h.service.advance('flow-1', NOW);

    expect(h.rulings.createForFlow).toHaveBeenCalledTimes(1);
    expect(h.rulings.createForFlow.mock.calls[0][0].text).toBe('verified: b');
  });

  it('AC-12: records the refusals without a ticket comment when the RUN has no ticket', async () => {
    const h = build({ realRulings: true, rulings: [{ item: 'F-1', ruling: 'verified: a' }] });

    await h.service.advance('flow-1', NOW);

    expect(h.real?.effects.ensureFinishTicket).not.toHaveBeenCalled();
    expect(h.real?.effects.commentOnRulingResult).toHaveBeenCalledExactlyOnceWith(
      RUN_JOB, 'Flow rulings refused (RULE job rule-1): F-1 (not in task)',
    );
    expect(h.real?.tickets.flatMap((ticket) => ticket.comments)).toEqual([]);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'flow.rulings',
      payload: expect.objectContaining({ recorded: [], refused: [{ item: 'F-1', reason: 'not in task' }] }),
    }));
  });

  it('AC-12: the refusal reaches the tickets of a RUN that has one', async () => {
    const h = build({ realRulings: true, rulings: [{ item: 'D-1', ruling: 'verified: a' }, { item: 'F-1', ruling: 'verified: a' }] });

    await h.service.advance('flow-1', NOW);

    expect(h.real?.effects.ensureFinishTicket).toHaveBeenCalledOnce();
    expect(h.real?.tickets[0]?.comments).toContain('Flow rulings refused (RULE job rule-1): F-1 (not in task)');
  });

  it('AC-13: writes no second ruling, comment or audit entry when the tick retries the same verdict', async () => {
    const h = build({ realRulings: true });
    h.steps.recordRulings.mockRejectedValueOnce(new Error('tick crashed'));

    await expect(h.service.advance('flow-1', NOW)).rejects.toThrow('tick crashed');
    expect(h.real?.repo.insert).toHaveBeenCalledTimes(2);

    await h.service.advance('flow-1', NOW);

    expect(h.real?.repo.insert).toHaveBeenCalledTimes(2);
    expect(h.real?.effects.createSystemRulingComment).toHaveBeenCalledTimes(2);
    expect(h.real?.audit.record).toHaveBeenCalledTimes(2);
    expect(h.steps.recordRulings).toHaveBeenCalledTimes(2);
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ recorded: ['D-1', 'S-1'], refused: [] }),
    }));
  });

  it('AC-14: still applies the SPEC_REVIEW calls of an existing review', async () => {
    const h = build({
      latest: {
        flowStep: 'SPEC_REVIEW',
        agentResult: { status: 'completed', output: JSON.stringify({ findings: [FINDING] }) },
      },
    });

    await h.service.advance('flow-1', NOW);

    expect(h.calls.apply).toHaveBeenCalledExactlyOnceWith(h.row, {
      kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: RULE_JOB, findings: [FINDING],
    }, 's1', { feature: 'f', specPath: '.nax/features/f/spec.md', branch: 'feat/f' });
    expect(h.rulings.createForFlow).not.toHaveBeenCalled();
  });
});
