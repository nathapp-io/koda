import { computeCorrection, ESCALATED_FROM_AUDIT, NOTHING_PUSHED } from './ingest-corrections';
import type { CorrectionInput } from './ingest-corrections';
import type { FinishInfo } from './parsers/finish.parser';

const job = (over: Partial<CorrectionInput['job']> = {}): CorrectionInput['job'] => ({
  state: 'COMPLETED', command: 'RUN', leaseEpoch: 1, costSpentUsd: '0.0745', stateReason: null, finishResult: null,
  escalationReason: null, resultPrUrl: null, resultBranch: null, resultSha: null, ...over,
});
const finish = (over = {}): FinishInfo => ({ status: 'escalated', escalationReason: 'why', prUrl: 'https://x/pull/1', branch: 'feat/a', headSha: 'abc', ...over });
const input = (over: Partial<CorrectionInput> = {}): CorrectionInput => ({ job: job(), leaseEpoch: 1, ledgerCostUsd: '0.15730000', runStatus: 'completed', finish: null, ...over });

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
    expect(c).toEqual({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
  });
});
