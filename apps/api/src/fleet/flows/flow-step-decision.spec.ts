import { describe, expect, it } from 'vitest';
import { FLOW_CALLS_MAX_FINDINGS, flowQuestions, formatQuestions, type FlowAnswer } from './flow-calls';
import { formatFindings } from './flow-verdict';
import type { FlowOpenItem, FlowRuling } from './flow-rulings';
import { decideFlowStep, type FlowJobView, type FlowStepInput } from './flow-step-decision';
import type { FlowPrdEdit } from './flow-prd-edits';

const approvedAt = new Date('2026-11-07T12:00:00.000Z');
const input = (overrides: Partial<FlowStepInput> = {}): FlowStepInput => ({
  state: 'RUNNING', featureCount: 1, approvedAt, latestJob: null, now: new Date(10_000),
  prWaitMs: 5_000, ingestSettled: false, featurePrNumber: null,
  callsJobId: null, planCount: 0, canApplyCalls: false, questionsJobId: null, answers: null, ...overrides,
});
const job = (overrides: Partial<FlowJobView> = {}): FlowJobView => ({
  id: 'j1', step: 'PLAN', state: 'COMPLETED', stateReason: null,
  queuedAt: new Date('2026-11-07T12:01:00.000Z'), finishedAt: new Date(6_000), prNumber: null,
  agentOutput: null, resultBranch: null, resultSha: null, fixReady: null, ...overrides,
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
    expect(decideFlowStep(input({ latestJob: job({ step: 'RUN', state: 'ESCALATED', prNumber: 12, resultSha: 'abc1234' }) })))
      .toEqual({ kind: 'dispatch', step: 'REVIEW', pr: { number: 12, headSha: 'abc1234' } });
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
    expect(decideFlowStep(input({ latestJob: job({ step: 'SPEC_REVIEW', agentOutput: '{"findings":[{"id":"F1","class":"minor","summary":"Missing AC","fix":"add it"}]}' }) }))).toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-008 AC-4 formats findings with formatFindings', () => {
    const findings = [{ id: 'F1', class: 'minor' as const, summary: 'Missing AC', fix: 'add it' }];
    expect(decideFlowStep(input({ latestJob: job({ step: 'SPEC_REVIEW', agentOutput: '{"findings":[{"id":"F1","class":"minor","summary":"Missing AC","fix":"add it"}]}' }) }))).toEqual({ kind: 'stop', reason: 'review_findings', detail: formatFindings(findings) });
  });
  it('US-008 AC-5 stops on PRD_REVIEW findings', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'PRD_REVIEW', agentOutput: '{"findings":[{"class":"minor","summary":"Update plan","fix":"update it"}]}' }) }))).toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-008 AC-6 reports an unreadable null SPEC_REVIEW output', () => {
    expect(decideFlowStep(input({ latestJob: job({ id: 'j2', step: 'SPEC_REVIEW', agentOutput: null }) }))).toEqual({ kind: 'stop', reason: 'verdict_unreadable', detail: 'SPEC_REVIEW job j2: verdict unreadable (no agent output)' });
  });
  it('#415 names the parse reason in the unreadable stop detail', () => {
    expect(decideFlowStep(input({ latestJob: job({ id: 'j3', step: 'SPEC_REVIEW', agentOutput: '{"findings":[{"summary":"s"}]}' }) })))
      .toEqual({ kind: 'stop', reason: 'verdict_unreadable', detail: 'SPEC_REVIEW job j3: verdict unreadable (finding 1 has no valid class)' });
  });
  it.each([
    { class: 'minor', summary: 'Missing fix' },
    { class: 'answered', summary: 'Blank fix', fix: '   ' },
  ])('#415 treats a fix-less $class finding as a note, so a clean SPEC_REVIEW plans', (finding) => {
    expect(decideFlowStep(input({ canApplyCalls: true,
      latestJob: job({ step: 'SPEC_REVIEW', agentOutput: JSON.stringify({ findings: [finding] }) }) })))
      .toEqual({ kind: 'dispatch', step: 'PLAN' });
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

  it('US-009 AC-1 dispatches REVIEW with the RUN PR number and result sha', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'RUN', prNumber: 12, resultSha: 'abc1234' }) })))
      .toEqual({ kind: 'dispatch', step: 'REVIEW', pr: { number: 12, headSha: 'abc1234' } });
  });
  it('US-009 AC-2 waits for RUN ingest while within the PR wait window', () => {
    expect(decideFlowStep(input({ now: new Date(10_000), prWaitMs: 5_000, ingestSettled: false,
      latestJob: job({ step: 'RUN', finishedAt: new Date(6_000) }) }))).toEqual({ kind: 'wait' });
  });
  it('US-009 AC-3 stops a RUN without a PR after ingest settles', () => {
    expect(decideFlowStep(input({ ingestSettled: true, latestJob: job({ step: 'RUN', finishedAt: new Date(6_000) }) })))
      .toMatchObject({ kind: 'stop', reason: 'run_no_pr' });
  });
  it('US-009 AC-4 stops a RUN without a PR at the wait boundary', () => {
    expect(decideFlowStep(input({ now: new Date(11_000), prWaitMs: 5_000, ingestSettled: false,
      latestJob: job({ step: 'RUN', finishedAt: new Date(6_000) }) }))).toMatchObject({ kind: 'stop', reason: 'run_no_pr' });
  });
  it('US-009 AC-5 dispatches FIX after REVIEW using the feature PR number', () => {
    expect(decideFlowStep(input({ featurePrNumber: 12, latestJob: job({ step: 'REVIEW' }) })))
      .toEqual({ kind: 'dispatch', step: 'FIX', pr: { number: 12 } });
  });
  it('US-009 AC-6 completes after FIX marks the PR ready', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'FIX', fixReady: { markedReady: true } }) }))).toEqual({ kind: 'complete' });
  });
  it('US-009 AC-7 stops after FIX is held not ready with the hold detail', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'FIX', fixReady: { markedReady: false, readyHeld: 'no CI' } }) })))
      .toEqual({ kind: 'stop', reason: 'pr_not_ready', detail: 'no CI' });
  });
  it('#411 completes after FIX finds the PR already ready (markedReady false, no hold)', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'FIX', fixReady: { markedReady: false } }) }))).toEqual({ kind: 'complete' });
  });
  it('#411 completes after FIX finds the PR already ready with replies or resolutions recorded', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'FIX', fixReady: { markedReady: false, replied: 1, resolved: 1 } }) })))
      .toEqual({ kind: 'complete' });
  });
  it('#411 still stops when FIX is held with a hold reason', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'FIX', fixReady: { markedReady: false, readyHeld: 'CI failure: test' } }) })))
      .toEqual({ kind: 'stop', reason: 'pr_not_ready', detail: 'CI failure: test' });
  });
  it('US-009 AC-8 stops after FIX ends without a ready result', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'FIX', fixReady: null }) })))
      .toEqual({ kind: 'stop', reason: 'pr_not_ready', detail: 'FIX ended without a ready result' });
  });

  it('US-008 AC-1 waits for guidance after a held FIX', () => {
    expect(decideFlowStep(input({ canApplyCalls: true,
      latestJob: job({ id: 'fix-1', step: 'FIX', fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' } }) })))
      .toEqual({ kind: 'wait_answer', step: 'FIX', jobId: 'fix-1', questions: [{ id: '1', question: 'PR still held after FIX fix-1: 1 open item(s): G-1. Answer with guidance for one more ruling and FIX round, or stop the flow.' }] });
  });
  it('US-008 AC-2 dispatches RULE after the FIX hold is answered', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, questionsJobId: 'fix-1', answers: [{ id: '1', answer: 'Please address G-1' }],
      latestJob: job({ id: 'fix-1', step: 'FIX', fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' } }) })))
      .toEqual({ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: 'fix-1' } });
  });
  it('US-008 AC-3 does not use answers associated with an older job', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, questionsJobId: 'older-fix', answers: [{ id: '1', answer: 'stale guidance' }],
      latestJob: job({ id: 'fix-2', step: 'FIX', fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' } }) })))
      .toMatchObject({ kind: 'wait_answer', step: 'FIX', jobId: 'fix-2' });
  });
  it.each([
    'CI failure: test',
    'CI no-checks: no CI check reported within 20m 0s',
  ])('US-008 AC-4/5 stops on CI hold: %s', (readyHeld) => {
    expect(decideFlowStep(input({ canApplyCalls: true,
      latestJob: job({ step: 'FIX', fixReady: { markedReady: false, readyHeld } }) })))
      .toEqual({ kind: 'stop', reason: 'pr_not_ready', detail: readyHeld });
  });
  it('US-008 AC-6 preserves thread-entry stop for held FIX', () => {
    expect(decideFlowStep(input({ canApplyCalls: false,
      latestJob: job({ step: 'FIX', fixReady: { markedReady: false, readyHeld: '1 open item(s): G-1' } }) })))
      .toEqual({ kind: 'stop', reason: 'pr_not_ready', detail: '1 open item(s): G-1' });
  });
  it('US-008 AC-7 stops FIX without a ready result', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: job({ step: 'FIX', fixReady: null }) })))
      .toEqual({ kind: 'stop', reason: 'pr_not_ready', detail: 'FIX ended without a ready result' });
  });
  it('US-008 AC-8 completes a ready FIX', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: job({ step: 'FIX', fixReady: { markedReady: true } }) })))
      .toEqual({ kind: 'complete' });
  });
  it('US-008 AC-9 completes a FIX with no hold reason', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: job({ step: 'FIX', fixReady: { markedReady: false } }) })))
      .toEqual({ kind: 'complete' });
  });
  it('US-009 AC-9 waits on an escalated RUN until ingest or timeout', () => {
    expect(decideFlowStep(input({ now: new Date(10_000), prWaitMs: 5_000, ingestSettled: false,
      latestJob: job({ step: 'RUN', state: 'ESCALATED', finishedAt: new Date(6_000) }) }))).toEqual({ kind: 'wait' });
  });
  it.each([
    { ingestSettled: true, now: new Date(10_000) },
    { ingestSettled: false, now: new Date(11_000) },
  ])('US-009 AC-10 stops an escalated RUN without a PR when settled or timed out', (wait) => {
    expect(decideFlowStep(input({ ...wait, prWaitMs: 5_000,
      latestJob: job({ step: 'RUN', state: 'ESCALATED', finishedAt: new Date(6_000) }) })))
      .toMatchObject({ kind: 'stop', reason: 'run_no_pr' });
  });
  it('US-009 AC-11 preserves generic failure precedence for RUN despite its PR', () => {
    expect(decideFlowStep(input({ latestJob: job({ step: 'RUN', state: 'FAILED', prNumber: 12 }) })))
      .toMatchObject({ kind: 'stop', reason: 'step_failed' });
  });

  const minor = { id: 'm1', class: 'minor', summary: 'Small issue', fix: 'Fix it' };
  const ambiguous = { id: 'a1', class: 'ambiguous', summary: 'Need user input', question: 'Which option?' };
  const classifiedReview = (step: 'SPEC_REVIEW' | 'PRD_REVIEW', findings: unknown[], id = 'j1') =>
    job({ id, step, agentOutput: JSON.stringify({ findings }) });

  it('US-005 AC-1 stops ambiguous SPEC_REVIEW findings with formatted questions', () => {
    expect(decideFlowStep(input({ latestJob: classifiedReview('SPEC_REVIEW', [ambiguous]) })))
      .toEqual({ kind: 'stop', reason: 'review_ambiguous', detail: formatQuestions([ambiguous]) });
  });
  it('US-005 AC-2 ambiguous findings wait for answers when calls can be applied', () => {
    const findings = [minor, ambiguous];
    const review = classifiedReview('SPEC_REVIEW', findings);
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: review })))
      .toEqual({ kind: 'wait_answer', step: 'SPEC_REVIEW', jobId: 'j1', questions: flowQuestions(findings) });
  });

  it('US-004 AC-2 waits on a PRD_REVIEW ambiguity', () => {
    const findings = [minor, ambiguous];
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: classifiedReview('PRD_REVIEW', findings) })))
      .toEqual({ kind: 'wait_answer', step: 'PRD_REVIEW', jobId: 'j1', questions: flowQuestions(findings) });
  });
  it('US-004 AC-3 waits before the second-round PRD findings stop', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2,
      latestJob: classifiedReview('PRD_REVIEW', [ambiguous]) }))).toMatchObject({ kind: 'wait_answer' });
  });
  it.each([
    { questionsJobId: 'older', answers: [{ id: '2', answer: 'A1' }] as FlowAnswer[] },
    { questionsJobId: 'j1', answers: null },
  ])('US-004 AC-4/5 waits unless current review has bound answers', (answerState) => {
    expect(decideFlowStep(input({ canApplyCalls: true, ...answerState,
      latestJob: classifiedReview('SPEC_REVIEW', [ambiguous]) }))).toMatchObject({ kind: 'wait_answer', jobId: 'j1' });
  });
  it('US-004 AC-6 enriches ambiguous findings by question position', () => {
    const findings = [minor, ambiguous];
    expect(decideFlowStep(input({ canApplyCalls: true, questionsJobId: 'j1',
      answers: [{ id: '2', answer: 'A1' }], latestJob: classifiedReview('SPEC_REVIEW', findings) })))
      .toEqual({ kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [minor, { ...ambiguous, answer: 'A1' }] });
  });
  it('US-004 AC-7 applies answered second-round PRD ambiguity', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2, questionsJobId: 'j1',
      answers: [{ id: '1', answer: 'A1' }], latestJob: classifiedReview('PRD_REVIEW', [ambiguous]) })))
      .toMatchObject({ kind: 'apply_calls' });
  });
  it('US-004 AC-8 dispatches PLAN after already-recorded answered review', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, callsJobId: 'j1', questionsJobId: 'j1',
      answers: [{ id: '1', answer: 'A1' }], latestJob: classifiedReview('SPEC_REVIEW', [ambiguous]) })))
      .toEqual({ kind: 'dispatch', step: 'PLAN' });
  });
  it('US-004 AC-10 preserves thread-entry ambiguity stop above the findings cap', () => {
    const findings = Array.from({ length: 21 }, (_, i) => i === 0 ? ambiguous : { ...minor, id: `m${i}` });
    expect(decideFlowStep(input({ canApplyCalls: false, latestJob: classifiedReview('SPEC_REVIEW', findings) })))
      .toMatchObject({ kind: 'stop', reason: 'review_ambiguous' });
  });
  it('US-004 AC-11 enforces finding cap before waiting', () => {
    const findings = Array.from({ length: 21 }, (_, i) => i === 0 ? ambiguous : { ...minor, id: `m${i}` });
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: classifiedReview('SPEC_REVIEW', findings) })))
      .toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-004 AC-12 accepts second-round minor PRD findings instead of stopping', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2,
      latestJob: classifiedReview('PRD_REVIEW', [minor]) })))
      .toEqual({ kind: 'apply_prd_edits', jobId: 'j1', edits: [], accepted: [minor] });
  });
  it('US-004 AC-13 stops over-limit findings regardless of class', () => {
    const findings = Array.from({ length: 21 }, (_, i) => ({ ...minor, id: `m${i}` }));
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: classifiedReview('SPEC_REVIEW', findings) })))
      .toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-005 AC-3 stops findings above the calls limit', () => {
    const findings = Array.from({ length: FLOW_CALLS_MAX_FINDINGS + 1 }, (_, index) => ({ ...minor, id: `m${index}` }));
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: classifiedReview('SPEC_REVIEW', findings) })))
      .toMatchObject({ kind: 'stop', reason: 'review_findings' });
  });
  it('US-005 AC-4 stops findings when calls cannot be applied', () => {
    expect(decideFlowStep(input({ latestJob: classifiedReview('SPEC_REVIEW', [minor]) })))
      .toEqual({ kind: 'stop', reason: 'review_findings', detail: formatFindings([minor]) });
  });
  it('US-005 AC-5 applies calls for a first nax-entry SPEC_REVIEW finding', () => {
    expect(decideFlowStep(input({ canApplyCalls: true,
      latestJob: classifiedReview('SPEC_REVIEW', [minor], 'j1') })))
      .toEqual({ kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1', findings: [minor] });
  });
  it('US-005 AC-6 dispatches PLAN when the SPEC_REVIEW calls are already recorded', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, callsJobId: 'j1',
      latestJob: classifiedReview('SPEC_REVIEW', [minor], 'j1') })))
      .toEqual({ kind: 'dispatch', step: 'PLAN' });
  });
  it('US-005 AC-7 applies calls for a first-round PRD_REVIEW finding', () => {
    const finding = { id: 'a1', class: 'answered', summary: 'Covered', fix: 'Record it' };
    expect(decideFlowStep(input({ canApplyCalls: true, planCount: 1,
      latestJob: classifiedReview('PRD_REVIEW', [finding], 'j2') })))
      .toEqual({ kind: 'apply_calls', step: 'PRD_REVIEW', jobId: 'j2', findings: [finding] });
  });
  it('US-005 AC-8 dispatches PLAN when the PRD_REVIEW calls are already recorded', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, callsJobId: 'j2', planCount: 1,
      latestJob: classifiedReview('PRD_REVIEW', [minor], 'j2') })))
      .toEqual({ kind: 'dispatch', step: 'PLAN' });
  });
  it('US-005 AC-9 accepts findings in the second PRD_REVIEW round', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2,
      latestJob: classifiedReview('PRD_REVIEW', [minor], 'j3') })))
      .toEqual({ kind: 'apply_prd_edits', jobId: 'j3', edits: [], accepted: [minor] });
  });
  it('US-005 AC-10 permits an empty second-round PRD_REVIEW', () => {
    expect(decideFlowStep(input({ planCount: 2,
      latestJob: classifiedReview('PRD_REVIEW', []) }))).toEqual({ kind: 'dispatch', step: 'RUN' });
  });
  it('US-005 AC-11 keeps empty SPEC_REVIEW dispatch behavior', () => {
    expect(decideFlowStep(input({ latestJob: classifiedReview('SPEC_REVIEW', []) })))
      .toEqual({ kind: 'dispatch', step: 'PLAN' });
  });
  const advisorItem: FlowOpenItem = { id: 'S-2', kind: 'advisor', issue: 'Question' };
  const ruleVerdict = (rulings: FlowRuling[] = [], questions: { item: string; question: string }[] = []) => JSON.stringify({ rulings, questions });
  const ruleJob = (overrides: Partial<FlowJobView> = {}) => job({ id: 'rule-1', step: 'RULE', agentOutput: ruleVerdict(), ...overrides });

  it('US-007 AC-1 dispatches RULE for draft workflow advisor items', () => {
    expect(decideFlowStep(input({ featurePrNumber: 12, run: { outcome: 'draft', openItems: [advisorItem] }, latestJob: job({ step: 'REVIEW' }) })))
      .toEqual({ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: null } });
  });
  it('US-007 AC-2 dispatches FIX for a ready run', () => {
    expect(decideFlowStep(input({ featurePrNumber: 12, run: { outcome: 'ready', openItems: [advisorItem] }, latestJob: job({ step: 'REVIEW' }) })))
      .toEqual({ kind: 'dispatch', step: 'FIX', pr: { number: 12 } });
  });
  it('US-007 AC-3 does not rule draft findings or gates', () => {
    expect(decideFlowStep(input({ featurePrNumber: 12, run: { outcome: 'draft', openItems: [{ ...advisorItem, kind: 'finding' }, { ...advisorItem, id: 'G', kind: 'gate' }] }, latestJob: job({ step: 'REVIEW' }) })))
      .toEqual({ kind: 'dispatch', step: 'FIX', pr: { number: 12 } });
  });
  it('US-007 AC-4 preserves FIX dispatch when RUN data is absent', () => {
    expect(decideFlowStep(input({ featurePrNumber: 12, latestJob: job({ step: 'REVIEW' }) })))
      .toEqual({ kind: 'dispatch', step: 'FIX', pr: { number: 12 } });
  });
  it('US-007 AC-5 stops on unreadable RULE verdict', () => {
    expect(decideFlowStep(input({ latestJob: ruleJob({ agentOutput: 'no json' }) })))
      .toEqual({ kind: 'stop', reason: 'verdict_unreadable', detail: 'RULE job rule-1: no rulings JSON in the agent output' });
  });
  it('US-007 AC-6 applies readable rulings', () => {
    const rulings = [{ item: 'S-2', ruling: 'verified: evidence' }];
    expect(decideFlowStep(input({ latestJob: ruleJob({ agentOutput: ruleVerdict(rulings) }) })))
      .toEqual({ kind: 'apply_rulings', jobId: 'rule-1', rulings });
  });
  it('US-007 AC-7 applies an empty ruling set', () => {
    expect(decideFlowStep(input({ latestJob: ruleJob() }))).toEqual({ kind: 'apply_rulings', jobId: 'rule-1', rulings: [] });
  });
  it('US-007 AC-8 dispatches FIX after rulings are recorded', () => {
    expect(decideFlowStep(input({ featurePrNumber: 12, rulingsJobId: 'rule-1', latestJob: ruleJob() })))
      .toEqual({ kind: 'dispatch', step: 'FIX', pr: { number: 12 } });
  });
  it('US-007 AC-9 waits for PR after rulings are recorded', () => {
    expect(decideFlowStep(input({ rulingsJobId: 'rule-1', latestJob: ruleJob() }))).toEqual({ kind: 'wait' });
  });
  it('US-007 AC-10 asks RULE questions positionally', () => {
    const verdict = ruleVerdict([], [{ item: 'S-2', question: 'Which?' }]);
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: ruleJob({ agentOutput: verdict }) })))
      .toEqual({ kind: 'wait_answer', step: 'RULE', jobId: 'rule-1', questions: [{ id: '1', question: 'S-2: Which?' }] });
  });
  it('sanitizes RULE item labels before wait questions and stop details', () => {
    const unsafeItem = `S-\u0000\uD800-2`;
    const latestJob = ruleJob({ agentOutput: ruleVerdict([], [{ item: unsafeItem, question: 'Which?' }]) });
    const waiting = decideFlowStep(input({ canApplyCalls: true, latestJob }));
    expect(waiting).toEqual({ kind: 'wait_answer', step: 'RULE', jobId: 'rule-1', questions: [{ id: '1', question: 'S-\uFFFD\uFFFD-2: Which?' }] });
    const stopped = decideFlowStep(input({ canApplyCalls: false, latestJob }));
    expect(stopped).toEqual({ kind: 'stop', reason: 'review_ambiguous', detail: '1. S-\uFFFD\uFFFD-2: Which?' });
  });
  it('US-007 AC-11 questions take precedence over rulings', () => {
    const verdict = ruleVerdict([{ item: 'S-2', ruling: 'verified: evidence' }], [{ item: 'S-3', question: 'Which?' }]);
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: ruleJob({ agentOutput: verdict }) }))).toMatchObject({ kind: 'wait_answer', step: 'RULE' });
  });
  it('US-007 AC-12 stops RULE questions when calls cannot be applied', () => {
    expect(decideFlowStep(input({ latestJob: ruleJob({ agentOutput: ruleVerdict([], [{ item: 'S-2', question: 'Which?' }]) }) })))
      .toMatchObject({ kind: 'stop', reason: 'review_ambiguous' });
  });
  it('US-007 AC-13 stops RULE questions above the cap', () => {
    const questions = Array.from({ length: FLOW_CALLS_MAX_FINDINGS + 1 }, (_, index) => ({ item: `S-${index}`, question: 'Which?' }));
    expect(decideFlowStep(input({ canApplyCalls: true, latestJob: ruleJob({ agentOutput: ruleVerdict([], questions) }) })))
      .toMatchObject({ kind: 'stop', reason: 'review_ambiguous' });
  });
  it('US-007 AC-14 dispatches guided RULE after answers', () => {
    expect(decideFlowStep(input({ canApplyCalls: true, questionsJobId: 'rule-1', answers: [{ id: '1', answer: 'A' }],
      latestJob: ruleJob({ agentOutput: ruleVerdict([], [{ item: 'S-2', question: 'Which?' }]) }) })))
      .toEqual({ kind: 'dispatch', step: 'RULE', rule: { answeredJobId: 'rule-1' } });
  });
  it.each(['FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] as const)('US-007 AC-15 stops terminal RULE %s', (state) => {
    expect(decideFlowStep(input({ latestJob: ruleJob({ state }) }))).toMatchObject({ kind: 'stop', reason: 'step_failed' });
  });

  describe('US-006 PRD edit and two-pass review decisions', () => {
    const edit: FlowPrdEdit = { story: 'US-001', op: 'add_ac', new: 'Cover the behavior' };
    const reviewWithEdits = (step: 'SPEC_REVIEW' | 'PRD_REVIEW', findings: unknown[], id = 'review-1') =>
      job({ id, step, agentOutput: JSON.stringify({ findings, prdEdits: [edit] }) });

    it('AC-1 repeats SPEC_REVIEW after first-pass calls', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, callsJobId: 'review-1', specReviewCount: 1,
        latestJob: reviewWithEdits('SPEC_REVIEW', [minor]) })))
        .toEqual({ kind: 'dispatch', step: 'SPEC_REVIEW' });
    });
    it('AC-2 dispatches PLAN after second-pass calls', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, callsJobId: 'review-1', specReviewCount: 2,
        latestJob: reviewWithEdits('SPEC_REVIEW', [minor]) })))
        .toEqual({ kind: 'dispatch', step: 'PLAN' });
    });
    it('AC-3 keeps dispatching PLAN when the spec review count is absent', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, callsJobId: 'review-1',
        latestJob: reviewWithEdits('SPEC_REVIEW', [minor]) })))
        .toEqual({ kind: 'dispatch', step: 'PLAN' });
    });
    it('AC-4 sends an empty SPEC_REVIEW verdict to PLAN on either pass', () => {
      expect(decideFlowStep(input({ specReviewCount: 1,
        latestJob: job({ step: 'SPEC_REVIEW', agentOutput: '{"findings":[]}' }) })))
        .toEqual({ kind: 'dispatch', step: 'PLAN' });
    });
    it('AC-5 applies calls from second-pass findings when they are not recorded yet', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, specReviewCount: 2,
        latestJob: reviewWithEdits('SPEC_REVIEW', [minor]) })))
        .toEqual({ kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'review-1', findings: [minor] });
    });
    it('AC-6 applies PRD edits after a no-findings PRD_REVIEW', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 1,
        latestJob: reviewWithEdits('PRD_REVIEW', []) })))
        .toEqual({ kind: 'apply_prd_edits', jobId: 'review-1', edits: [edit], accepted: [] });
    });
    it('AC-7 dispatches RUN when PRD edits for this job are already recorded', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 1, prdEditsJobId: 'review-1',
        latestJob: reviewWithEdits('PRD_REVIEW', []) })))
        .toEqual({ kind: 'dispatch', step: 'RUN' });
    });
    it('AC-8 ignores PRD edits when calls cannot be applied', () => {
      expect(decideFlowStep(input({ canApplyCalls: false, planCount: 1,
        latestJob: reviewWithEdits('PRD_REVIEW', []) })))
        .toEqual({ kind: 'dispatch', step: 'RUN' });
    });
    it('AC-9 applies first-round PRD findings and ignores accompanying edits', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 1,
        latestJob: reviewWithEdits('PRD_REVIEW', [minor]) })))
        .toEqual({ kind: 'apply_calls', step: 'PRD_REVIEW', jobId: 'review-1', findings: [minor] });
    });
    it.each(['SPEC_REVIEW', 'PRD_REVIEW'] as const)(
      'AC-10 keeps the 21-finding cap for %s in every round', (step) => {
        const findings = Array.from({ length: 21 }, (_, index) => ({ ...minor, id: `m${index}` }));
        expect(decideFlowStep(input({ canApplyCalls: true, specReviewCount: 2, planCount: 2,
          latestJob: reviewWithEdits(step, findings) })))
          .toMatchObject({ kind: 'stop', reason: 'review_findings' });
      },
    );
  });

  describe('US-010 second-round PRD findings are accepted, not committed as calls', () => {
    const edit: FlowPrdEdit = { story: 'US-001', op: 'add_ac', new: 'Cover the behavior' };
    const secondRound = (findings: unknown[], id = 'review-2') =>
      job({ id, step: 'PRD_REVIEW', agentOutput: JSON.stringify({ findings, prdEdits: [edit] }) });

    it('AC-1 applies the second-round PRD edits and accepts the findings', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2,
        latestJob: secondRound([minor]) })))
        .toEqual({ kind: 'apply_prd_edits', jobId: 'review-2', edits: [edit], accepted: [minor] });
    });
    it('AC-2 dispatches RUN when the second-round edits are already recorded', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2, prdEditsJobId: 'review-2',
        latestJob: secondRound([minor]) })))
        .toEqual({ kind: 'dispatch', step: 'RUN' });
    });
    it('AC-3 stops a second-round PRD_REVIEW above the findings cap', () => {
      const findings = Array.from({ length: 21 }, (_, index) => ({ ...minor, id: `m${index}` }));
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2,
        latestJob: secondRound(findings) })))
        .toMatchObject({ kind: 'stop', reason: 'review_findings' });
    });
    it('AC-1/2 keeps the first-round PRD_REVIEW on the calls path', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 1,
        latestJob: secondRound([minor], 'review-1') })))
        .toEqual({ kind: 'apply_calls', step: 'PRD_REVIEW', jobId: 'review-1', findings: [minor] });
    });
    it('AC-1/2 re-plans a second-round PRD_REVIEW that carries current answers', () => {
      expect(decideFlowStep(input({ canApplyCalls: true, planCount: 2, questionsJobId: 'review-2',
        answers: [{ id: '1', answer: 'A1' }], latestJob: secondRound([minor]) })))
        .toEqual({ kind: 'apply_calls', step: 'PRD_REVIEW', jobId: 'review-2', findings: [minor] });
    });
  });

  it.each([
    { summary: 'Missing class', fix: 'fix' },
    { class: 'major', summary: 'Unknown class', fix: 'fix' },
    { class: 'ambiguous', summary: 'Missing question' },
    { class: 'ambiguous', summary: 'Blank question', question: '  ' },
  ])('US-005 AC-12..15 rejects unreadable classified findings: $summary', (finding) => {
    expect(decideFlowStep(input({ canApplyCalls: true,
      latestJob: job({ step: 'SPEC_REVIEW', agentOutput: JSON.stringify({ findings: [finding] }) }) })))
      .toMatchObject({ kind: 'stop', reason: 'verdict_unreadable' });
  });
});
