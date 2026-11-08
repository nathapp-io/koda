import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';
import { FLOW_CALL_TEXT_MAX, oneLine, truncateFlowText, type FlowAnswer, type FlowQuestion } from './flow-calls';

export type FlowRuling = { item: string; ruling: string };
export type FlowRuleQuestion = { item: string; question: string };
export const FLOW_RULINGS_MAX = 100;

type FlowRuleVerdict = { rulings: unknown; questions: unknown };

export function parseRuleVerdict(output: string | null):
  | { ok: true; rulings: FlowRuling[]; questions: FlowRuleQuestion[] }
  | { ok: false } {
  if (typeof output !== 'string') return { ok: false };

  const lines = output.split(/\r?\n/);
  let markerLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('{"rulings"')) markerLine = index;
  }
  if (markerLine < 0) return { ok: false };

  let candidate = lines.slice(markerLine).join('\n').trim();
  candidate = candidate.replace(/\n\s*```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || !('rulings' in parsed) || !('questions' in parsed)) return { ok: false };
  const { rulings, questions } = parsed as FlowRuleVerdict;
  if (!Array.isArray(rulings) || !Array.isArray(questions) || rulings.length > FLOW_RULINGS_MAX) return { ok: false };

  const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const safeText = (value: string, max: number): string => truncateFlowText(value.split('\u0000').join('\uFFFD'), max);
  const safeRulings: FlowRuling[] = [];
  for (const ruling of rulings) {
    if (typeof ruling !== 'object' || ruling === null || !('item' in ruling) || !validText(ruling.item) || !('ruling' in ruling) || !validText(ruling.ruling)) return { ok: false };
    safeRulings.push({ item: ruling.item, ruling: safeText(ruling.ruling, 2000) });
  }

  const safeQuestions: FlowRuleQuestion[] = [];
  for (const question of questions) {
    if (typeof question !== 'object' || question === null || !('item' in question) || !validText(question.item) || !('question' in question) || !validText(question.question)) return { ok: false };
    safeQuestions.push({ item: question.item, question: safeText(question.question, FLOW_CALL_TEXT_MAX) });
  }
  return { ok: true, rulings: safeRulings, questions: safeQuestions };
}

export type FlowOpenItem = {
  id: string;
  kind: string;
  issue: string;
  severity?: string | null;
  file?: string | null;
  line?: number | null;
  suggestion?: string | null;
};

export type FlowRuleGuidance = { held: string | null; questions: FlowQuestion[]; answers: FlowAnswer[] };

export const FLOW_RULE_KINDS = ['advisor', 'ruling', 'cannot-verify', 'story', 'reason'] as const;

export const FLOW_RULING_INSTRUCTION = `Rule only the listed items; do not rule any other item.
Never rule a finding; a code gap is fixed by FIX, not by a ruling.
For advisor or ruling items, use verified: <evidence> when the premise holds and nothing remains to change.
Use confirm: <evidence> only for a code change nax bot fix can push; never confirm a PRD or acceptance-criteria edit.
Use override: <reason> when the premise is wrong. defer is not a ruling.
For cannot-verify items, use verified: <evidence> after running what it names, otherwise waive: <why it cannot be checked>.
For story items, use waive: <reason citing the spec or PRD line> when out of scope or accepted; do not rule a code gap.
For reason items, use verified: <evidence> or waive: <reason>.
For gate items, re-run nax gates run --gate <name> --json; use fixed <head sha> only when green at the head, and do not rule it when red.
Ask a question only when its answer changes what gets built and the spec, PRD and code do not settle it.
End with one JSON object on its own line, with no text after it:
{"rulings":[{"item":"<id>","ruling":"<keyword line and evidence>"}],"questions":[{"item":"<id>","question":"<question>"}]}`;

export function ruleTaskItems(items: FlowOpenItem[], ruledItemIds: string[]): FlowOpenItem[] {
  const ruled = new Set(ruledItemIds);
  return items.filter(({ id, kind }) => kind !== 'finding' && kind !== 'ci' && !ruled.has(id));
}

export function needsAutomaticRule(items: FlowOpenItem[], ruledItemIds: string[]): boolean {
  const kinds: readonly string[] = FLOW_RULE_KINDS;
  return ruleTaskItems(items, ruledItemIds).some(({ kind }) => kinds.includes(kind));
}

function itemLine(item: FlowOpenItem): string {
  const id = oneLine(item.id);
  const kind = oneLine(item.kind);
  const severity = item.severity == null || oneLine(item.severity) === '' ? '' : `, ${oneLine(item.severity)}`;
  const location = item.file == null || oneLine(item.file) === ''
    ? ''
    : ` ${oneLine(item.file)}${item.line == null ? '' : `:${item.line}`}`;
  const suggestion = item.suggestion == null || oneLine(item.suggestion) === '' ? '' : ` Suggestion: ${oneLine(item.suggestion)}`;
  return `- ${id} (${kind}${severity})${location}: ${oneLine(item.issue)}${suggestion}`;
}

export function buildRuleTask(input: { prNumber: number; items: FlowOpenItem[]; guidance: FlowRuleGuidance | null }): string {
  const prefix = [`Rule the open workflow items of PR #${input.prNumber}.`, ''];
  if (input.guidance !== null) {
    const guidance = ['Guidance from the user:'];
    if (input.guidance.held !== null) guidance.push(truncateFlowText(`Still held: ${oneLine(input.guidance.held)}`, 500));
    const answers = new Map(input.guidance.answers.map(({ id, answer }) => [id, answer]));
    for (const question of input.guidance.questions) {
      const answer = answers.get(question.id);
      if (answer !== undefined) guidance.push(truncateFlowText(`Q${oneLine(question.id)}: ${oneLine(question.question)} A: ${oneLine(answer)}`, 300));
    }
    prefix.push(...guidance, '');
  }

  const lines = input.items.map(itemLine);
  const suffix = ['', FLOW_RULING_INSTRUCTION];
  const render = (visible: string[], dropped: number): string => [
    ...prefix,
    ...visible,
    ...(dropped > 0 ? [`(${dropped} more items not shown)`] : []),
    ...suffix,
  ].join('\n');

  let visible = [...lines];
  let task = render(visible, 0);
  while (task.length > AGENT_TASK_MAX_LENGTH && visible.length > 0) {
    visible.pop();
    task = render(visible, lines.length - visible.length);
  }
  if (task.length > AGENT_TASK_MAX_LENGTH) {
    // Guidance is capped by the caller's contract; reserve the instruction even for unusual oversized PR numbers.
    const fixed = [...prefix, ...suffix].join('\n');
    return `${fixed.slice(0, Math.max(0, AGENT_TASK_MAX_LENGTH - FLOW_RULING_INSTRUCTION.length - 2))}\n\n${FLOW_RULING_INSTRUCTION}`;
  }
  return task;
}
