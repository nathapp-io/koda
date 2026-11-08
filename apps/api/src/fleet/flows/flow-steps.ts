import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';

export type FlowStep = 'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'RULE' | 'FIX';

export const FLOW_VERDICT_INSTRUCTION = `When you are done, end your reply with exactly one JSON object on its own line, with no text after it:
{"findings":[{"id":"<short id>","class":"answered|minor|ambiguous","summary":"<one sentence>","fix":"<the change, for answered and minor>","question":"<the question, for ambiguous>"}]}
Classes: "answered" = the spec, the brainstorm or the code already settles it; "minor" = a small call you can make
and record; "ambiguous" = only the user can settle it, because the answer changes what gets built.
Use {"findings":[]} when you found nothing that should change before the next step.
{"findings":[]}`;

/**
 * #409 follow-up: a flow records its calls by appending `## Flow's calls`, never by editing the body. Without this,
 * every review round flags "the body above still says X", and the second PRD round stops the flow.
 */
export const FLOW_CALLS_PRECEDENCE = `The spec may end with a "## Flow's calls" section. Each call there is a recorded decision that amends the spec text above it and wins wherever they disagree.
Read the spec as amended by those calls. Do not report a finding only because the text above has not been edited to match a call, and do not re-raise a finding a call already settles.`;

export const FLOW_STOP_DETAIL_MAX = 2000;

export const FLOW_PRD_EDITS_INSTRUCTION = `Fix every PRD defect you can yourself, as edits, instead of reporting it. Add a "prdEdits" array to the same JSON object, after "findings": the object must still start with {"findings".
Each edit is one of: {"story":"<id>","op":"replace_description","old":"<exact text in the description>","new":"<text>"}, {"story":"<id>","op":"replace_ac","old":"<exact criterion>","new":"<criterion>"}, {"story":"<id>","op":"remove_ac","old":"<exact criterion>"}, {"story":"<id>","op":"add_ac","new":"<criterion>"}, {"story":"<id>","op":"add_context_file","path":"<repo path>"}, {"story":"<id>","op":"remove_context_file","path":"<repo path>"}.
Edit only a story's description, acceptance criteria and context files. Never remove a criterion that carries a spec acceptance criterion. Do not report or edit "analysis": it reaches no prompt.
Keep the whole JSON line under 6000 bytes of UTF-8 and at most 12 edits; when more are needed, keep the most important edits and report the rest as one minor finding.
Report a finding only when the spec itself must change or only the user can decide. Do not edit any file: the flow commits your edits.`;

type ReviewStep = Extract<FlowStep, 'SPEC_REVIEW' | 'PRD_REVIEW'>;

export function buildReviewTask(step: ReviewStep, specPath: string, feature: string, options?: { prdEdits?: boolean }): string {
  const prompt = step === 'SPEC_REVIEW'
    ? `/spec-review ${specPath}`
    : `/spec-review --spec ${specPath} --prd .nax/features/${feature}/prd.json --phase 9`;
  const suffix = `\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}${step === 'PRD_REVIEW' && options?.prdEdits === true ? `\n\n${FLOW_PRD_EDITS_INSTRUCTION}` : ''}`;
  const promptLimit = Math.max(0, AGENT_TASK_MAX_LENGTH - suffix.length);

  return `${prompt.slice(0, promptLimit)}${suffix}`;
}
