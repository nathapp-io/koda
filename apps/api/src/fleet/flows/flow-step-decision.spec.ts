import { describe, expect, it } from 'vitest';
import { decideFlowStep, type FlowJobView, type FlowStepInput } from './flow-step-decision';

const approvedAt = new Date('2026-11-07T12:00:00.000Z');
const input = (overrides: Partial<FlowStepInput> = {}): FlowStepInput => ({
  state: 'RUNNING', featureCount: 1, approvedAt, latestJob: null, ...overrides,
});
const job = (overrides: Partial<FlowJobView> = {}): FlowJobView => ({
  id: 'j1', step: 'PLAN', state: 'COMPLETED', stateReason: null,
  queuedAt: new Date('2026-11-07T12:01:00.000Z'), prNumber: null, ...overrides,
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
});
