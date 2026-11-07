import { ACTIVE_STATES } from '../jobs/job-state';
import type { FlowStep } from './flow-steps';
import type { FleetFlowState } from './flow-states';

export interface FlowJobView {
  id: string;
  step: FlowStep;
  state: string;
  stateReason: string | null;
  queuedAt: Date;
  prNumber: number | null;
}

export interface FlowStepInput {
  state: FleetFlowState;
  featureCount: number;
  approvedAt: Date;
  latestJob: FlowJobView | null;
}

export type FlowStopReason =
  | 'step_failed'
  | 'verdict_unreadable'
  | 'review_findings'
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
  | { kind: 'dispatch'; step: FlowStep; pr?: { number: number; headSha?: string } };

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
  if (latestJob.step === 'RUN' && latestJob.state === 'ESCALATED' && latestJob.prNumber !== null) {
    return { kind: 'dispatch', step: 'REVIEW', pr: { number: latestJob.prNumber } };
  }

  // Completed-step progression is deliberately owned by the next flow-step story.
  return { kind: 'wait' };
}
