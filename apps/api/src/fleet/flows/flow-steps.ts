import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';

export type FlowStep = 'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX';

export const FLOW_VERDICT_INSTRUCTION = `When you are done, end your reply with exactly one JSON object on its own line, with no text after it:
{"findings":[{"id":"<short id>","summary":"<one sentence>"}]}
Use {"findings":[]} when you found nothing that should change before the next step.
{"findings":[]}`;

export const FLOW_STOP_DETAIL_MAX = 2000;

type ReviewStep = Extract<FlowStep, 'SPEC_REVIEW' | 'PRD_REVIEW'>;

export function buildReviewTask(step: ReviewStep, specPath: string, feature: string): string {
  const prompt = step === 'SPEC_REVIEW'
    ? `/spec-review ${specPath}`
    : `/spec-review --spec ${specPath} --prd .nax/features/${feature}/prd.json`;
  const suffix = `\n\n${FLOW_VERDICT_INSTRUCTION}`;
  const promptLimit = Math.max(0, AGENT_TASK_MAX_LENGTH - suffix.length);

  return `${prompt.slice(0, promptLimit)}${suffix}`;
}
