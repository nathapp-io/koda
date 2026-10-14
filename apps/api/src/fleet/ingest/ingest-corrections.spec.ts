import { computeCorrection, ESCALATED_FROM_AUDIT, ESCALATED_FROM_WORKFLOW, NOTHING_PUSHED } from './ingest-corrections';
import type { CorrectionInput } from './ingest-corrections';
import type { FinishInfo } from './parsers/finish.parser';

const draftWorkflow = { runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03', outcome: 'draft' as const, workflowPassed: true, reasons: ['CI failed: test'], openItems: [] };
const job = (over: Partial<CorrectionInput['job']> = {}): CorrectionInput['job'] => ({
  state: 'COMPLETED', command: 'RUN', leaseEpoch: 1, costSpentUsd: '0.0745', stateReason: null, finishResult: null,
  escalationReason: null, resultPrUrl: null, resultBranch: null, resultSha: null, workflow: null, ...over,
});
const finish = (over = {}): FinishInfo => ({ status: 'escalated', escalationReason: 'why', prUrl: 'https://x/pull/1', branch: 'feat/a', headSha: 'abc', ...over });
const input = (over: Partial<CorrectionInput> = {}): CorrectionInput => ({ job: job(), leaseEpoch: 1, ledgerCostUsd: '0.15730000', runStatus: 'completed', finish: null, workflow: null, workflowOutcome: null, workflowUrl: null, ...over });

describe('computeCorrection (spec §3)', () => {
  it('raises cost to the rounded ledger total (#203, nax#2348)', () => {
    const c = computeCorrection(input());
    expect(c.patch.costSpentUsd).toBe('0.1573');
    expect(c.costRaised).toBe(true);
    expect(c.liveCostUsd).toBe('0.0745');
  });

  it('never lowers cost (ledger missed an in-flight session)', () => {
    const c = computeCorrection(input({ ledgerCostUsd: '0.01' }));
    expect(c.patch.costSpentUsd).toBeUndefined();
    expect(c.costRaised).toBe(false);
  });

  it('rounds half-up to 4 places (A7)', () => {
    expect(computeCorrection(input({ job: job({ costSpentUsd: '0' }), ledgerCostUsd: '0.00435' })).patch.costSpentUsd).toBe('0.0044');
  });

  it('corrects COMPLETED -> ESCALATED and fills empty finish fields only', () => {
    const c = computeCorrection(input({ job: job({ resultBranch: 'from-status' }), finish: finish() }));
    expect(c.escalated).toBe(true);
    expect(c.patch).toMatchObject({
      state: 'ESCALATED', stateReason: ESCALATED_FROM_AUDIT, finishResult: 'escalated', escalationReason: 'why',
      resultPrUrl: 'https://x/pull/1', resultSha: 'abc',
    });
    expect(c.patch.resultBranch).toBeUndefined();
  });

  it('fills a PR link without changing state for an opened finish', () => {
    const c = computeCorrection(input({ finish: finish({ status: 'opened', escalationReason: null }) }));
    expect(c.escalated).toBe(false);
    expect(c.patch.state).toBeUndefined();
    expect(c.patch).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://x/pull/1' });
  });

  it('never changes any other state', () => {
    for (const state of ['FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] as const) {
      expect(computeCorrection(input({ job: job({ state }), finish: finish() })).patch.state).toBeUndefined();
    }
  });

  it('marks a COMPLETED RUN with no finish and no branch as nothing pushed (#204)', () => {
    expect(computeCorrection(input()).patch.stateReason).toBe(NOTHING_PUSHED);
    expect(computeCorrection(input({ finish: finish({ status: 'skipped', prUrl: null, branch: null, headSha: null }) })).patch.stateReason).toBe(NOTHING_PUSHED);
    expect(computeCorrection(input({ job: job({ resultBranch: 'b' }) })).patch.stateReason).toBeUndefined();
    expect(computeCorrection(input({ job: job({ command: 'PLAN' }) })).patch.stateReason).toBeUndefined();
    expect(computeCorrection(input({ job: job({ stateReason: 'kept' }) })).patch.stateReason).toBeUndefined();
  });

  it('ignores finish for PLAN jobs and for runs not completed', () => {
    expect(computeCorrection(input({ job: job({ command: 'PLAN' }), finish: finish() })).escalated).toBe(false);
    expect(computeCorrection(input({ runStatus: 'failed', finish: finish() })).escalated).toBe(false);
  });

  it('changes nothing on the job for an earlier attempt (D367, Review Focus 2)', () => {
    const c = computeCorrection(input({ job: job({ leaseEpoch: 2 }), leaseEpoch: 1, finish: finish() }));
    expect(c).toEqual({ patch: {}, costRaised: false, escalated: false, escalatedFrom: null, liveCostUsd: null });
  });

  it('AC-4 escalates a COMPLETED RUN whose workflow outcome is draft', () => {
    const c = computeCorrection(input({ workflow: draftWorkflow, workflowOutcome: 'draft', workflowUrl: 'https://github.com/o/r/pull/5' }));
    expect(c.patch).toMatchObject({ state: 'ESCALATED', stateReason: ESCALATED_FROM_WORKFLOW });
    expect(ESCALATED_FROM_WORKFLOW).toBe('workflow draft (from status)');
    expect(c.escalated).toBe(true);
    expect(c.escalatedFrom).toBe('workflow');
  });

  it('AC-5 leaves an ESCALATED RUN alone for a draft outcome', () => {
    const c = computeCorrection(input({ job: job({ state: 'ESCALATED' }), workflow: draftWorkflow, workflowOutcome: 'draft', workflowUrl: 'https://github.com/o/r/pull/5' }));
    expect(c.patch.state).toBeUndefined();
    expect(c.escalated).toBe(false);
    expect(c.escalatedFrom).toBeNull();
  });

  it('AC-6 fills workflow when the job has none', () => {
    const c = computeCorrection(input({ workflow: draftWorkflow, workflowOutcome: 'ready', workflowUrl: null }));
    expect(c.patch.workflow).toEqual(draftWorkflow);
  });

  it('AC-7 never overwrites an existing workflow', () => {
    const c = computeCorrection(input({ job: job({ workflow: draftWorkflow }), workflow: draftWorkflow, workflowOutcome: 'ready', workflowUrl: null }));
    expect(c.patch.workflow).toBeUndefined();
  });

  it('AC-8 fills resultPrUrl from the workflow url', () => {
    const c = computeCorrection(input({ workflowOutcome: 'ready', workflowUrl: 'https://github.com/o/r/pull/3' }));
    expect(c.patch.resultPrUrl).toBe('https://github.com/o/r/pull/3');
  });

  it('AC-9 never marks nothing-pushed when a workflow outcome is present', () => {
    const c = computeCorrection(input({ job: job({ costSpentUsd: '0.1573' }), ledgerCostUsd: '0.1573', workflowOutcome: 'ready', workflow: draftWorkflow }));
    expect(c.patch.stateReason).toBeUndefined();
  });

  it('AC-10 ignores a bundle from an older lease epoch even with a draft outcome', () => {
    const c = computeCorrection(input({ job: job({ leaseEpoch: 2 }), leaseEpoch: 1, workflow: draftWorkflow, workflowOutcome: 'draft', workflowUrl: 'https://github.com/o/r/pull/5' }));
    expect(c.patch).toEqual({});
  });

  it('AC-11 leaves a PLAN job alone for a draft outcome', () => {
    const c = computeCorrection(input({ job: job({ command: 'PLAN' }), workflow: draftWorkflow, workflowOutcome: 'draft', workflowUrl: 'https://github.com/o/r/pull/5' }));
    expect(c.patch.state).toBeUndefined();
    expect(c.patch.workflow).toBeUndefined();
  });

  it('AC-12 reports finish-audit when the finish record escalates without workflow inputs', () => {
    const c = computeCorrection(input({ finish: finish() }));
    expect(c.escalatedFrom).toBe('finish-audit');
  });

  it('gives a present ready workflow precedence over escalated finish fields and PR url', () => {
    const c = computeCorrection(input({
      finish: finish(), workflow: { ...draftWorkflow, outcome: 'ready' }, workflowOutcome: 'ready',
      workflowUrl: 'https://github.com/o/r/pull/workflow',
    }));
    expect(c.patch).not.toHaveProperty('state');
    expect(c.patch).not.toHaveProperty('finishResult');
    expect(c.patch).not.toHaveProperty('escalationReason');
    expect(c.patch).toMatchObject({ resultPrUrl: 'https://github.com/o/r/pull/workflow' });
    expect(c.escalated).toBe(false);
    expect(c.escalatedFrom).toBeNull();
  });

  it('keeps workflow draft escalation rather than applying finish-audit correction', () => {
    const c = computeCorrection(input({
      finish: finish(), workflow: draftWorkflow, workflowOutcome: 'draft',
      workflowUrl: 'https://github.com/o/r/pull/workflow',
    }));
    expect(c.patch).toMatchObject({ state: 'ESCALATED', stateReason: ESCALATED_FROM_WORKFLOW, resultPrUrl: 'https://github.com/o/r/pull/workflow' });
    expect(c.patch.finishResult).toBeUndefined();
    expect(c.escalatedFrom).toBe('workflow');
  });
});
