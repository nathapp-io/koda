import { ACTIVE_STATES } from '../jobs/job-state';
import type { FlowStep } from './flow-steps';
import { FLOW_CALLS_MAX_FINDINGS, flowQuestions, formatQuestions, type FlowAnswer, type FlowQuestion } from './flow-calls';
import { formatFindings, parseFlowVerdict } from './flow-verdict';
import type { FlowFinding } from './flow-verdict';
import type { FixReady } from '../jobs/domain/fleet-job.domain';
import type { FleetFlowState } from './flow-states';

export interface FlowJobView {
  id: string;
  step: FlowStep;
  state: string;
  stateReason: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
  prNumber: number | null;
  agentOutput: string | null;
  resultBranch: string | null;
  resultSha: string | null;
  fixReady: FixReady | null;
}

export interface FlowStepInput {
  state: FleetFlowState;
  featureCount: number;
  approvedAt: Date;
  latestJob: FlowJobView | null;
  now: Date;
  prWaitMs: number;
  ingestSettled: boolean;
  featurePrNumber: number | null;
  callsJobId: string | null;
  planCount: number;
  canApplyCalls: boolean;
  questionsJobId: string | null;
  answers: FlowAnswer[] | null;
}

export type FlowStopReason =
  | 'step_failed'
  | 'verdict_unreadable'
  | 'review_findings'
  | 'review_ambiguous'
  | 'calls_failed'
  | 'plan_no_result'
  | 'run_no_pr'
  | 'pr_not_ready'
  | 'cost_cap'
  | 'creator_lost_access'
  | 'budget_paused'
  | 'dispatch_refused';

export type FlowStepAction =
  | { kind: 'skip' }
  | { kind: 'wait' }
  | { kind: 'complete' }
  | { kind: 'stop'; reason: FlowStopReason; detail: string }
  | { kind: 'dispatch'; step: FlowStep; pr?: { number: number; headSha?: string } }
  | { kind: 'apply_calls'; step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; findings: FlowFinding[] }
  | { kind: 'wait_answer'; step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; questions: FlowQuestion[] };

export type ApplyCallsAction = Extract<FlowStepAction, { kind: 'apply_calls' }>;
export type WaitAnswerAction = Extract<FlowStepAction, { kind: 'wait_answer' }>;

const dispatch = (step: FlowStep): FlowStepAction => ({ kind: 'dispatch', step });

function failed(job: FlowJobView): FlowStepAction {
  const reason = job.stateReason ?? 'no reason';
  return {
    kind: 'stop',
    reason: 'step_failed',
    detail: `${job.step} job ${job.id} ${job.state}: ${reason}`,
  };
}

export function decideFlowStep(input: FlowStepInput): FlowStepAction {
  if (input.featureCount !== 1) return { kind: 'skip' };

  const { state, latestJob } = input;
  if (!latestJob) return state === 'APPROVED' || state === 'RUNNING' ? dispatch('SPEC_REVIEW') : { kind: 'wait' };

  const adoptedSpecReview = latestJob.step === 'SPEC_REVIEW'
    && latestJob.queuedAt.getTime() >= input.approvedAt.getTime();
  if (state === 'APPROVED' && !adoptedSpecReview) return dispatch('SPEC_REVIEW');

  if (latestJob.state === 'FAILED' || latestJob.state === 'CANCELLED' || latestJob.state === 'CRASHED') {
    return failed(latestJob);
  }
  if (latestJob.state === 'ESCALATED' && latestJob.step !== 'RUN') return failed(latestJob);

  if (state === 'APPROVED') return { kind: 'wait' };

  if (state !== 'RUNNING') return { kind: 'wait' };
  if ((ACTIVE_STATES as readonly string[]).includes(latestJob.state)) return { kind: 'wait' };
  if (latestJob.step === 'RUN' && (latestJob.state === 'COMPLETED' || latestJob.state === 'ESCALATED')) {
    if (latestJob.prNumber !== null && latestJob.resultSha) {
      return {
        kind: 'dispatch',
        step: 'REVIEW',
        pr: { number: latestJob.prNumber, headSha: latestJob.resultSha },
      };
    }
    const timedOut = latestJob.finishedAt !== null
      && input.now.getTime() - latestJob.finishedAt.getTime() >= input.prWaitMs;
    if (input.ingestSettled || timedOut) {
      return {
        kind: 'stop', reason: 'run_no_pr',
        detail: latestJob.prNumber === null ? 'RUN ended without a PR' : 'RUN PR has no result sha for REVIEW',
      };
    }
    return { kind: 'wait' };
  }

  if (latestJob.state === 'COMPLETED') {
    if (latestJob.step === 'SPEC_REVIEW' || latestJob.step === 'PRD_REVIEW') {
      const verdict = parseFlowVerdict(latestJob.agentOutput);
      if (!verdict.ok) {
        return {
          kind: 'stop',
          reason: 'verdict_unreadable',
          detail: `${latestJob.step} job ${latestJob.id}: no verdict JSON in the agent output`,
        };
      }
      if (verdict.findings.length === 0) {
        return dispatch(latestJob.step === 'SPEC_REVIEW' ? 'PLAN' : 'RUN');
      }
      const ambiguous = verdict.findings.filter((finding) => finding.class === 'ambiguous');
      const stopFindings = (): FlowStepAction => ({
        kind: 'stop', reason: 'review_findings', detail: formatFindings(verdict.findings),
      });
      if (ambiguous.length > 0 && !input.canApplyCalls) {
        return { kind: 'stop', reason: 'review_ambiguous', detail: formatQuestions(ambiguous) };
      }
      if (verdict.findings.length > FLOW_CALLS_MAX_FINDINGS) return stopFindings();
      if (!input.canApplyCalls) return stopFindings();
      const hasCurrentAnswers = input.questionsJobId === latestJob.id && input.answers !== null;
      if (ambiguous.length > 0 && !hasCurrentAnswers) {
        return { kind: 'wait_answer', step: latestJob.step, jobId: latestJob.id, questions: flowQuestions(verdict.findings) };
      }
      if (latestJob.step === 'PRD_REVIEW' && input.planCount >= 2 && ambiguous.length === 0) return stopFindings();
      if (input.callsJobId === latestJob.id) return dispatch('PLAN');
      const findings = hasCurrentAnswers
        ? verdict.findings.map((finding, index) => finding.class !== 'ambiguous'
          ? finding
          : { ...finding, ...(input.answers?.find((answer) => answer.id === String(index + 1))?.answer === undefined
            ? {} : { answer: input.answers.find((answer) => answer.id === String(index + 1))?.answer }) })
        : verdict.findings;
      return { kind: 'apply_calls', step: latestJob.step, jobId: latestJob.id, findings };
    }

    if (latestJob.step === 'PLAN') {
      if (!latestJob.resultBranch || !latestJob.resultSha) {
        return { kind: 'stop', reason: 'plan_no_result', detail: 'PLAN job has no result branch or sha' };
      }
      return dispatch('PRD_REVIEW');
    }

    if (latestJob.step === 'REVIEW') {
      return input.featurePrNumber === null
        ? { kind: 'wait' }
        : { kind: 'dispatch', step: 'FIX', pr: { number: input.featurePrNumber } };
    }

    if (latestJob.step === 'FIX') {
      if (latestJob.fixReady?.markedReady === true) return { kind: 'complete' };
      return {
        kind: 'stop',
        reason: 'pr_not_ready',
        detail: latestJob.fixReady?.readyHeld ?? 'FIX ended without a ready result',
      };
    }
  }

  return { kind: 'wait' };
}
