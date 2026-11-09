import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';

export type FlowStep = 'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'RULE' | 'FIX';

export const FLOW_VERDICT_INSTRUCTION = `When you are done, end your reply with exactly one JSON object on its own line, with no text after it:
{"findings":[{"id":"<short id>","class":"answered|minor|ambiguous","summary":"<one sentence>","fix":"<the change, for answered and minor>","question":"<the question, for ambiguous>"}]}
Classes: "answered" = the spec, the brainstorm or the code already settles it; "minor" = a small call you can make
and record; "ambiguous" = only the user can settle it, because the answer changes what gets built.
Use {"findings":[]} when you found nothing that should change before the next step.
Leave out anything that needs no change: a note such as "already settled" is not a finding, and an "answered" or "minor" finding with an empty fix is dropped.
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

/**
 * The set review is one job over every spec of the flow: the task names each spec, asks for the
 * consistency a single spec cannot show (a rule fixed in one spec but used differently in another, an
 * undeclared dependency) and asks every finding to name the feature it belongs to, so a later pass can
 * route it to that feature. Only a set of two or more specs gets this wording: a one-spec review keeps
 * its exact previous task.
 */
export const FLOW_SET_REVIEW_INSTRUCTION = `This flow reviews a set of specs in one job. Review every spec of the set:
{specs}
Also check cross-spec consistency: a rule fixed in one spec but used differently in another, or an undeclared dependency between the specs.
Put "feature":"<feature>" on every finding, naming the feature it belongs to. The features of this set: {features}.`;

/**
 * The feature a spec path belongs to: `.nax/features/<feature>/spec.md` names `<feature>`. The spec
 * path is the only name the set carries, so the parent directory is the feature.
 */
function featureOfSpecPath(specPath: string): string {
  const parts = specPath.split('/').filter((part) => part.length > 0);
  return parts.length >= 2 ? parts[parts.length - 2] : specPath;
}

/** The set wording for the given spec paths, or null when the set is not a set. */
function setReviewInstruction(specPath: string, feature: string, setSpecPaths: readonly string[]): string | null {
  if (setSpecPaths.length < 2) return null;
  const specs = setSpecPaths.map((path) => `- ${path}`).join('\n');
  // The caller's own name wins for the spec it names: the feature names are what a finding is routed by.
  const features = [...new Set(setSpecPaths.map((path) => (path === specPath ? feature : featureOfSpecPath(path))))].join(', ');
  return FLOW_SET_REVIEW_INSTRUCTION
    .replace('{specs}', () => specs)
    .replace('{features}', () => features);
}

export function buildReviewTask(
  step: ReviewStep,
  specPath: string,
  feature: string,
  options?: { prdEdits?: boolean; setSpecPaths?: string[] },
): string {
  const setInstruction = step === 'SPEC_REVIEW'
    ? setReviewInstruction(specPath, feature, options?.setSpecPaths ?? [])
    : null;
  const prompt = step === 'SPEC_REVIEW'
    ? `/spec-review ${specPath}${setInstruction === null ? '' : `\n\n${setInstruction}`}`
    : `/spec-review --spec ${specPath} --prd .nax/features/${feature}/prd.json --phase 9`;
  const suffix = `\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}${step === 'PRD_REVIEW' && options?.prdEdits === true ? `\n\n${FLOW_PRD_EDITS_INSTRUCTION}` : ''}`;
  const promptLimit = Math.max(0, AGENT_TASK_MAX_LENGTH - suffix.length);

  return `${prompt.slice(0, promptLimit)}${suffix}`;
}
