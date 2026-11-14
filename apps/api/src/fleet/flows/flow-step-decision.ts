import { ACTIVE_STATES } from '../jobs/job-state';
import type { FlowStep } from './flow-steps';
import { FLOW_CALLS_MAX_FINDINGS, flowQuestions, formatQuestions, oneLine, sanitizeFlowText, type FlowAnswer, type FlowQuestion } from './flow-calls';
import { formatFindings, parseFlowVerdict } from './flow-verdict';
import { needsAutomaticRule, parseRuleVerdict, type FlowOpenItem, type FlowRuling } from './flow-rulings';
import type { FlowFinding } from './flow-verdict';
import type { FlowPrdEdit } from './flow-prd-edits';
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
  firstFeature: boolean;
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
  run?: { outcome: string | null; openItems: FlowOpenItem[] } | null;
  ruledItemIds?: string[];
  rulingsJobId?: string | null;
  specReviewCount?: number;
  prdEditsJobId?: string | null;
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
  | 'dispatch_refused'
  | 'pr_closed'
  | 'spec_changed'
  | 'internal_error';

export type FlowStepAction =
  | { kind: 'wait' }
  | { kind: 'complete' }
  | { kind: 'stop'; reason: FlowStopReason; detail: string }
  | { kind: 'dispatch'; step: FlowStep; pr?: { number: number; headSha?: string }; rule?: { answeredJobId: string | null }; accepted?: FlowFinding[] }
  | { kind: 'apply_calls'; step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; findings: FlowFinding[] }
  | { kind: 'apply_rulings'; jobId: string; rulings: FlowRuling[] }
  | { kind: 'apply_prd_edits'; jobId: string; edits: FlowPrdEdit[]; accepted: FlowFinding[] }
  | { kind: 'wait_answer'; step: 'SPEC_REVIEW' | 'PRD_REVIEW' | 'RULE' | 'FIX'; jobId: string; questions: FlowQuestion[] };

export type ApplyCallsAction = Extract<FlowStepAction, { kind: 'apply_calls' }>;
export type ApplyRulingsAction = Extract<FlowStepAction, { kind: 'apply_rulings' }>;
export type ApplyPrdEditsAction = Extract<FlowStepAction, { kind: 'apply_prd_edits' }>;
export type WaitAnswerAction = Extract<FlowStepAction, { kind: 'wait_answer' }>;

const dispatch = (step: FlowStep): FlowStepAction => ({ kind: 'dispatch', step });
const safeRuleItemLabel = (value: string): string => oneLine(sanitizeFlowText(value.split('\u0000').join('\uFFFD')));

function failed(job: FlowJobView): FlowStepAction {
  const reason = job.stateReason ?? 'no reason';
  return {
    kind: 'stop',
    reason: 'step_failed',
    detail: `${job.step} job ${job.id} ${job.state}: ${reason}`,
  };
}

export function decideFlowStep(input: FlowStepInput): FlowStepAction {
  const { state, latestJob, firstFeature } = input;
  if (!latestJob) {
    if (state === 'APPROVED') return firstFeature ? dispatch('SPEC_REVIEW') : { kind: 'wait' };
    if (state === 'RUNNING') return dispatch(firstFeature ? 'SPEC_REVIEW' : 'PLAN');
    return { kind: 'wait' };
  }

  const adoptedSpecReview = latestJob.step === 'SPEC_REVIEW'
    && latestJob.queuedAt.getTime() >= input.approvedAt.getTime();
  if (state === 'APPROVED' && firstFeature && !adoptedSpecReview) return dispatch('SPEC_REVIEW');

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
      // `in` narrows the union even without strictNullChecks (the api's tsconfig), where `!ok` does not.
      if ('reason' in verdict) {
        return {
          kind: 'stop',
          reason: 'verdict_unreadable',
          detail: `${latestJob.step} job ${latestJob.id}: verdict unreadable (${verdict.reason})`,
        };
      }
      if (verdict.findings.length === 0) {
        if (latestJob.step === 'PRD_REVIEW'
          && verdict.prdEdits.length > 0 && input.prdEditsJobId !== latestJob.id) {
          return { kind: 'apply_prd_edits', jobId: latestJob.id, edits: verdict.prdEdits, accepted: [] };
        }
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
      if (!input.canApplyCalls) {
        if (latestJob.step === 'SPEC_REVIEW') return { kind: 'dispatch', step: 'PLAN', accepted: verdict.findings };
        if (verdict.prdEdits.length > 0 && input.prdEditsJobId !== latestJob.id) {
          return { kind: 'apply_prd_edits', jobId: latestJob.id, edits: verdict.prdEdits, accepted: verdict.findings };
        }
        if (input.prdEditsJobId === latestJob.id) return dispatch('RUN');
        return { kind: 'dispatch', step: 'RUN', accepted: verdict.findings };
      }
      const hasCurrentAnswers = input.questionsJobId === latestJob.id && input.answers !== null;
      if (ambiguous.length > 0 && !hasCurrentAnswers) {
        return { kind: 'wait_answer', step: latestJob.step, jobId: latestJob.id, questions: flowQuestions(verdict.findings) };
      }
      // The second PRD round no longer re-plans: the RUN builds from the spec, so the review's own
      // edits are committed and its findings are accepted instead of being written into the spec.
      // A round the user answered still re-plans: the answer may change what is built.
      if (latestJob.step === 'PRD_REVIEW' && input.planCount >= 2 && !hasCurrentAnswers) {
        if (input.prdEditsJobId === latestJob.id) return dispatch('RUN');
        return { kind: 'apply_prd_edits', jobId: latestJob.id, edits: verdict.prdEdits, accepted: verdict.findings };
      }
      if (input.callsJobId === latestJob.id) {
        return dispatch(latestJob.step === 'SPEC_REVIEW'
          && input.specReviewCount !== undefined && input.specReviewCount < 2
          ? 'SPEC_REVIEW'
          : 'PLAN');
      }
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
      if (input.featurePrNumber === null) return { kind: 'wait' };
      if (input.run?.outcome === 'draft' && needsAutomaticRule(input.run.openItems, input.ruledItemIds ?? [])) {
        return { kind: 'dispatch', step: 'RULE', rule: { answeredJobId: null } };
      }
      return { kind: 'dispatch', step: 'FIX', pr: { number: input.featurePrNumber } };
    }

    if (latestJob.step === 'RULE') {
      const verdict = parseRuleVerdict(latestJob.agentOutput);
      if (!verdict.ok) {
        return { kind: 'stop', reason: 'verdict_unreadable', detail: `RULE job ${latestJob.id}: no rulings JSON in the agent output` };
      }
      if (verdict.questions.length > 0) {
        const detail = verdict.questions.map(({ item, question }, index) => `${index + 1}. ${safeRuleItemLabel(item)}: ${oneLine(question)}`).join(' ');
        if (!input.canApplyCalls || verdict.questions.length > FLOW_CALLS_MAX_FINDINGS) {
          return { kind: 'stop', reason: 'review_ambiguous', detail };
        }
        if (input.questionsJobId === latestJob.id && input.answers !== null) {
          return { kind: 'dispatch', step: 'RULE', rule: { answeredJobId: latestJob.id } };
        }
        return { kind: 'wait_answer', step: 'RULE', jobId: latestJob.id,
          questions: verdict.questions.map(({ item, question }, index) => ({ id: String(index + 1), question: `${safeRuleItemLabel(item)}: ${question}` })) };
      }
      if (input.rulingsJobId === latestJob.id) {
        return input.featurePrNumber === null
          ? { kind: 'wait' }
          : { kind: 'dispatch', step: 'FIX', pr: { number: input.featurePrNumber } };
      }
      return { kind: 'apply_rulings', jobId: latestJob.id, rulings: verdict.rulings };
    }

    if (latestJob.step === 'FIX') {
      if (latestJob.fixReady?.markedReady === true) return { kind: 'complete' };
      // #411: nax reports `markedReady: false` with no `readyHeld` only when the PR was already ready (not a draft);
      // every hold it applies carries a reason. A RUN that publishes a ready PR therefore completes here too.
      if (latestJob.fixReady && latestJob.fixReady.markedReady === false && !latestJob.fixReady.readyHeld) {
        return { kind: 'complete' };
      }
      const readyHeld = latestJob.fixReady?.readyHeld;
      const stop = (detail: string): FlowStepAction => ({ kind: 'stop', reason: 'pr_not_ready', detail });
      if (!readyHeld) return stop('FIX ended without a ready result');
      if (readyHeld.startsWith('CI ') || !input.canApplyCalls) return stop(readyHeld);
      if (input.questionsJobId === latestJob.id && input.answers !== null) {
        return { kind: 'dispatch', step: 'RULE', rule: { answeredJobId: latestJob.id } };
      }
      return {
        kind: 'wait_answer',
        step: 'FIX',
        jobId: latestJob.id,
        questions: [{
          id: '1',
          question: `PR still held after FIX ${latestJob.id}: ${readyHeld}. Answer with guidance for one more ruling and FIX round, or stop the flow.`,
        }],
      };
    }
  }

  return { kind: 'wait' };
}
