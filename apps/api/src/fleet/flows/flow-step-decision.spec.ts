import { describe, expect, it } from 'vitest';
import { formatFindings } from './flow-verdict';
import { decideFlowStep, type FlowJobView, type FlowStepInput } from './flow-step-decision';

const approvedAt = new Date('2026-11-07T12:00:00.000Z');
const input = (overrides: Partial<FlowStepInput> = {}): FlowStepInput => ({
  state: 'RUNNING', featureCount: 1, approvedAt, latestJob: null, ...overrides,
});
const job = (overrides: Partial<FlowJobView> = {}): FlowJobView => ({
  id: 'j1', step: 'PLAN', state: 'COMPLETED', stateReason: null,
  queuedAt: new Date('2026-11-07T12:01:00.000Z'), prNumber: null,
  agentOutput: null, resultBranch: null, resultSha: null, ...overrides,
});

describe('decideFlowStep', () => {
  it('AC-1 skips flows with multiple features', () => {
    expect(decideFlowStep(input({ featureCount: 2 }))).toEqual({ kind: 'skip' });
  });
  it('AC-2 starts an approved flow with spec review', () => {
    expect(decideFlowStep(input({ state: 'APPROVED' }))).toEqual({ kind: 'dispatch', step: 'SPEC_REVIEW' });
  });
  it('AC-3 does not adopt a pre-approval PLAN job', () => {
    expect(decideFlowStep(input({ state: 'APPROVED', latestJob: job({ step: 'PLAN', queuedAt: new Date(approvedAt.getTime() - 1) }) }))).toEqual({ kind: 'dispatch', step: 'SPEC_REVIEW' });
  });
  it.each(['FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] as const)(
    'AC-3 dispatches SPEC_REVIEW instead of stopping for pre-approval PLAN job in %s',
    (state) => {
      expect(decideFlowStep(input({
        state: 'APPROVED',
        latestJob: job({ step: 'PLAN', state, queuedAt: new Date(approvedAt.getTime() - 1) }),
      }))).toEqual({ kind: 'dispatch', step: 'SPEC_REVIEW' });
    },
  );
  it('AC-4 waits for a spec review queued at the approval epoch', () => {
    expect(decideFlowStep(input({ state: 'APPROVED', latestJob: job({ step: 'SPEC_REVIEW', state: 'RUNNING', queuedAt: approvedAt }) }))).toEqual({ kind: 'wait' });
  });
  it('AC-5 starts a running flow without a job at spec review', () => {
    expect(decideFlowStep(input())).toEqual({ kind: 'dispatch', step: 'SPEC_REVIEW' });
  });
  it.each(['QUEUED', 'UPLOADING'] as const)('AC-6/7 waits for an active %s job', (state) => {
    expect(decideFlowStep(input({ latestJob: job({ state }) }))).toEqual({ kind: 'wait' });
  });
  it('AC-8 stops failed jobs with a detailed reason', () => {
    expect(decideFlowStep(input({ latestJob: job({ state: 'FAILED', stateReason: 'checkout: no .nax dir' }) }))).toEqual({ kind: 'stop', reason: 'step_failed', detail: 'PLAN job j1 FAILED: checkout: no .nax dir' });
  });
  it('AC-9 stops cancelled jobs', () => {
    expect(decideFlowStep(input({ latestJob: job({ state: 'CANCELLED' }) }))).toMatchObject({ kind: 'stop', reason: 'step_failed' });
  });
  it('AC-10 uses a fallback for missing crash reasons', () => {
    expect(decideFlowStep(input({ latestJob: job({ state: 'CRASHED', stateReason: null }) }))).toMatchObject({ kind: 'stop', detail: expect.stringMatching(/CRASHED: no reason$/) });
  });
  it('AC-11 stops escalated non-RUN jobs', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'REVIEW', state: 'ESCALATED' }) }))).toMatchObject({ kind: 'stop', reason: 'step_failed' });
  });
  it('AC-12 hands an escalated RUN with a PR to REVIEW', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'RUN', state: 'ESCALATED', prNumber: 12 }) }))).toEqual({ kind: 'dispatch', step: 'REVIEW', pr: { number: 12 } });
  });
  it.each(['FAILED', 'CANCELLED', 'CRASHED'] as const)('AC-13 includes step, id, state and reason for %s', (state) => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PRD_REVIEW', state, stateReason: null }) }))).toEqual({ kind: 'stop', reason: 'step_failed', detail: `PRD_REVIEW job j1 ${state}: no reason` });
  });
  it('AC-14 stops escalated non-RUN jobs with the generic failure detail', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'REVIEW', state: 'ESCALATED', stateReason: 'agent refused' }) }))).toEqual({ kind: 'stop', reason: 'step_failed', detail: 'REVIEW job j1 ESCALATED: agent refused' });
  });

  it('US-008 AC-1 dispatches PLAN after an empty SPEC_REVIEW verdict', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'SPEC_REVIEW', agentOutput: 'reviewed\n{"findings":[]}' }) }))).toEqual({ kind: 'dispatch', step: 'PLAN' });
  });
  it('US-008 AC-2 dispatches RUN after an empty PRD_REVIEW verdict', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PRD_REVIEW', agentOutput: '{"findings":[]}' }) }))).toEqual({ kind: 'dispatch', step: 'RUN' });
  });
  it('US-008 AC-3 stops on SPEC_REVIEW findings', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'SPEC_REVIEW', agentOutput: '{"findings":[{"id":"F1","summary":"Missing AC"}]}' }) }))).toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-008 AC-4 formats findings with formatFindings', () => {
    const findings = [{ id: 'F1', summary: 'Missing AC' }];
    expect(decideFlowStep(input({ latestJob: job({ step: 'SPEC_REVIEW', agentOutput: '{"findings":[{"id":"F1","summary":"Missing AC"}]}' }) }))).toEqual({ kind: 'stop', reason: 'review_findings', detail: formatFindings(findings) });
  });
  it('US-008 AC-5 stops on PRD_REVIEW findings', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PRD_REVIEW', agentOutput: '{"findings":[{"summary":"Update plan"}]}' }) }))).toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-008 AC-6 reports an unreadable null SPEC_REVIEW output', () => {
    expect(decideFlowStep(input({ latestJob: job({ id: 'j2', step: 'SPEC_REVIEW', agentOutput: null }) }))).toEqual({ kind: 'stop', reason: 'verdict_unreadable', detail: 'SPEC_REVIEW job j2: no verdict JSON in the agent output' });
  });
  it('US-008 AC-7 reports an unreadable PRD_REVIEW output', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PRD_REVIEW', agentOutput: 'not a verdict' }) }))).toMatchObject({ kind: 'stop', reason: 'verdict_unreadable' });
  });
  it('US-008 AC-8 dispatches PRD_REVIEW when PLAN has a result branch and sha', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PLAN', resultBranch: 'feature/a', resultSha: 'abc123' }) }))).toEqual({ kind: 'dispatch', step: 'PRD_REVIEW' });
  });
  it('US-008 AC-9 stops when PLAN has no result sha', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PLAN', resultBranch: 'feature/a', resultSha: null }) }))).toMatchObject({ kind: 'stop', reason: 'plan_no_result' });
  });
  it('US-008 AC-10 stops when PLAN has no result branch', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PLAN', resultBranch: null, resultSha: 'abc123' }) }))).toMatchObject({ kind: 'stop', reason: 'plan_no_result' });
  });
  it('US-008 AC-11 waits while SPEC_REVIEW is active even if its output has a verdict', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'SPEC_REVIEW', state: 'RUNNING', agentOutput: '{"findings":[]}' }) }))).toEqual({ kind: 'wait' });
  });
});
