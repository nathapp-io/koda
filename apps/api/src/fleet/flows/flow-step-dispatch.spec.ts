import { describe, expect, it } from 'vitest';
import { buildReviewTask, type FlowStep } from './flow-steps';
import { buildRuleTask, type FlowOpenItem } from './flow-rulings';
import { buildStepDispatch, remainingCapUsd, type BuildStepDispatchInput } from './flow-step-dispatch';

const baseInput = (step: FlowStep): BuildStepDispatchInput => ({
  flow: { repoId: 'repo-1', branch: 'feat/f', specSha: 's1', reviewerRole: 'opus', pinnedRunnerId: null },
  feature: { feature: 'f', specPath: '.nax/features/f/spec.md' },
  step,
  remainingCapUsd: '6.7500',
  reviewAgent: 'Explore',
});

describe('remainingCapUsd', () => {
  it('subtracts and formats to four decimal places', () => { expect(remainingCapUsd('10', '3.25')).toBe('6.7500'); });
  it('rounds remaining budget down to four decimal places', () => { expect(remainingCapUsd('1', '0.33333')).toBe('0.6666'); });
  it('returns null below the minimum dispatch threshold', () => { expect(remainingCapUsd('10', '9.99995')).toBeNull(); });
  it('returns null when spending exceeds the cap', () => { expect(remainingCapUsd('5', '6')).toBeNull(); });
});

describe('buildStepDispatch', () => {
  it('builds an exact SPEC_REVIEW AGENT body', () => {
    expect(buildStepDispatch(baseInput('SPEC_REVIEW'))).toEqual({ repoId: 'repo-1', command: 'AGENT', feature: 'f', ref: 's1', bashMode: 'raw', maxCostUsd: 6.75,
      agent: { name: 'Explore', task: buildReviewTask('SPEC_REVIEW', '.nax/features/f/spec.md', 'f'), model: 'opus' } });
  });
  it('builds a PLAN body from the flow branch and spec path', () => {
    expect(buildStepDispatch(baseInput('PLAN'))).toEqual({ repoId: 'repo-1', command: 'PLAN', ref: 'feat/f', feature: 'f', planFrom: '.nax/features/f/spec.md', profiles: [], maxCostUsd: 6.75 });
  });
  it('forwards opt-in PRD edits to the PRD_REVIEW task', () => {
    const input = { ...baseInput('PRD_REVIEW'), prdEdits: true, plan: { resultSha: 'plan-sha', resultBranch: 'plan-branch' } };
    const dispatched = buildStepDispatch(input);
    expect(dispatched).toMatchObject({
      agent: { task: buildReviewTask('PRD_REVIEW', '.nax/features/f/spec.md', 'f', { prdEdits: true }) },
    });
    expect(dispatched.agent?.task).toContain('Do not edit any file: the flow commits your edits.');
    const legacy = { ...baseInput('PRD_REVIEW'), plan: { resultSha: 'plan-sha', resultBranch: 'plan-branch' } };
    expect(buildStepDispatch(legacy)).toMatchObject({
      agent: { task: buildReviewTask('PRD_REVIEW', '.nax/features/f/spec.md', 'f') },
    });
  });
  it('builds PRD_REVIEW against the PLAN result sha', () => {
    const input = { ...baseInput('PRD_REVIEW'), plan: { resultSha: 'plan-sha', resultBranch: 'plan-branch' } };
    expect(buildStepDispatch(input)).toEqual({ repoId: 'repo-1', command: 'AGENT', feature: 'f', ref: 'plan-sha', bashMode: 'raw', maxCostUsd: 6.75,
      agent: { name: 'Explore', task: buildReviewTask('PRD_REVIEW', '.nax/features/f/spec.md', 'f'), model: 'opus' } });
  });
  it('builds RUN against the PLAN result branch', () => {
    const input = { ...baseInput('RUN'), plan: { resultSha: 'plan-sha', resultBranch: 'plan-branch' } };
    expect(buildStepDispatch(input)).toEqual({ repoId: 'repo-1', command: 'RUN', ref: 'plan-branch', feature: 'f', profiles: [], maxCostUsd: 6.75 });
  });
  it('builds REVIEW without ref or feature', () => {
    expect(buildStepDispatch({ ...baseInput('REVIEW'), pr: { number: 12 } })).toEqual({ repoId: 'repo-1', command: 'REVIEW', prNumber: 12, profiles: [], maxCostUsd: 6.75 });
  });
  it('builds FIX without ref or feature', () => {
    expect(buildStepDispatch({ ...baseInput('FIX'), pr: { number: 12 } })).toEqual({ repoId: 'repo-1', command: 'FIX', prNumber: 12, profiles: [], maxCostUsd: 6.75 });
  });
  it('dispatches RULE as an AGENT task with the flow reviewer model and remaining cap', () => {
    const items: FlowOpenItem[] = [{ id: 'D-1', kind: 'advisor', issue: 'Confirm the behavior' }];
    const input = { ...baseInput('RULE'), rule: { ref: 'feat/x', prNumber: 7, items, guidance: null } };

    expect(buildStepDispatch(input)).toEqual({
      repoId: 'repo-1', command: 'AGENT', feature: 'f', ref: 'feat/x', bashMode: 'raw', maxCostUsd: 6.75,
      agent: { name: 'Explore', task: buildRuleTask({ prNumber: 7, items, guidance: null }), model: 'opus' },
    });
  });
  it('carries pinnedRunnerId on RULE dispatch', () => {
    const input = {
      ...baseInput('RULE'),
      flow: { ...baseInput('RULE').flow, pinnedRunnerId: 'runner-1' },
      rule: { ref: 'feat/x', prNumber: 7, items: [], guidance: null },
    };
    expect(buildStepDispatch(input)).toHaveProperty('pinnedRunnerId', 'runner-1');
  });
  it('requires RUN branch and PR inputs for RULE', () => {
    expect(() => buildStepDispatch(baseInput('RULE'))).toThrowError('RULE requires the RUN branch and PR');
  });
  it('includes pinnedRunnerId when set', () => {
    const input = baseInput('PLAN');
    expect(buildStepDispatch({ ...input, flow: { ...input.flow, pinnedRunnerId: 'r1' } })).toHaveProperty('pinnedRunnerId', 'r1');
  });
  it('omits pinnedRunnerId when null', () => { expect(buildStepDispatch(baseInput('PLAN'))).not.toHaveProperty('pinnedRunnerId'); });
  it('requires the PLAN result for RUN', () => { expect(() => buildStepDispatch(baseInput('RUN'))).toThrowError(/PLAN/i); });
  it('M2: rejects a RUN without a PLAN result branch instead of falling back to the default branch', () => {
    expect(() => buildStepDispatch({ ...baseInput('RUN'), plan: { resultSha: 'plan-sha', resultBranch: null } }))
      .toThrowError('RUN requires a PLAN result branch');
  });
  it('pins both review agent bodies', () => {
    const specReview = baseInput('SPEC_REVIEW');
    const prdReview = baseInput('PRD_REVIEW');
    const pinnedSpecReview = { ...specReview, flow: { ...specReview.flow, pinnedRunnerId: 'r1' } };
    const pinnedPrdReview = {
      ...prdReview,
      flow: { ...prdReview.flow, pinnedRunnerId: 'r1' },
      plan: { resultSha: 'plan-sha', resultBranch: 'plan-branch' },
    };
    expect(buildStepDispatch(pinnedSpecReview)).toHaveProperty('pinnedRunnerId', 'r1');
    expect(buildStepDispatch(pinnedPrdReview)).toHaveProperty('pinnedRunnerId', 'r1');
  });
});
