import type { FlowFinding } from './flow-verdict';

export const FLOW_CALLS_HEADING = "## Flow's calls";
export const FLOW_CALLS_MAX_FINDINGS = 20;
export const FLOW_CALL_TEXT_MAX = 1000;
export const FLOW_ANSWER_MAX = 1000;
export const FLOW_CALL_ID_MAX = 64;

export type FlowQuestion = { id: string; question: string };
export type FlowAnswer = { id: string; answer: string };
const FLOW_QUESTIONS_MAX = 2000;

export function callsOutcomeForForgeError(reason: string): 'failed' | 'retry' {
  return reason === 'app_not_installed' || reason === 'app_permissions_insufficient' || reason === 'repo_not_found'
    ? 'failed'
    : 'retry';
}

/**
 * True when every surrogate in the text belongs to a pair. A lone surrogate cannot be stored in a
 * PostgreSQL JSON column: `JSON.stringify` writes it as an unpaired `\udXXX` escape and the JSONB
 * parser rejects it.
 */
export function isWellFormedFlowText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : Number.NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Replace every lone surrogate with U+FFFD so the text stays storable in a JSON column. */
export function sanitizeFlowText(value: string): string {
  if (isWellFormedFlowText(value)) return value;
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : Number.NaN;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += '\uFFFD';
      }
      continue;
    }
    result += code >= 0xdc00 && code <= 0xdfff ? '\uFFFD' : value[index];
  }
  return result;
}

/**
 * Cut a text to `max` UTF-16 code units without splitting a surrogate pair. A cut between the two
 * halves of an astral character leaves a lone high surrogate, which PostgreSQL JSONB rejects, so
 * the text stops before the pair instead. A lone surrogate already in the text is replaced with
 * U+FFFD, because the text is persisted in a JSON column.
 */
export function truncateFlowText(value: string, max: number): string {
  const safe = sanitizeFlowText(value);
  if (safe.length <= max) return safe;
  const cut = safe.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function flowQuestions(findings: FlowFinding[]): FlowQuestion[] {
  return findings.flatMap((finding, index) => finding.class === 'ambiguous'
    ? [{ id: String(index + 1), question: truncateFlowText(oneLine(finding.question ?? ''), FLOW_CALL_TEXT_MAX) }]
    : []);
}

export function formatQuestionsComment(input: {
  step: 'SPEC_REVIEW' | 'PRD_REVIEW' | 'RULE' | 'FIX';
  jobId: string;
  questions: FlowQuestion[];
  answerPath: string;
}): string {
  const lines = [
    `Flow needs answers (${input.step} job ${input.jobId}):`,
    ...input.questions.map(({ id, question }) => `${id}. ${question}`),
  ];
  const firstId = input.questions[0]?.id ?? '';
  lines.push(`Answer every question with POST ${input.answerPath} and the body {"jobId":"${input.jobId}","answers":[{"id":"${firstId}","answer":"..."}]}.`);
  return lines.join('\n');
}

export function formatQuestions(findings: readonly FlowFinding[]): string {
  const ambiguous = findings.filter((finding) => finding.class === 'ambiguous');
  const noun = ambiguous.length === 1 ? 'question' : 'questions';
  const entries = ambiguous.map((finding, index) => {
    const id = finding.id === undefined ? '' : `[${oneLine(finding.id)}] `;
    return `${index + 1}. ${id}${oneLine(finding.question ?? '')}`;
  });
  const result = `${ambiguous.length} ${noun}: ${entries.join(' ')}`;
  if (result.length <= FLOW_QUESTIONS_MAX) return result;
  return `${truncateFlowText(result, FLOW_QUESTIONS_MAX - 1)}…`;
}

export function buildFlowCalls(
  specText: string,
  input: { step: 'SPEC_REVIEW' | 'PRD_REVIEW'; jobId: string; findings: FlowFinding[] },
): { text: string; alreadyApplied: boolean } {
  const blockHeading = `### ${input.step} job ${input.jobId}`;
  if (specText.split(/\r?\n/).includes(blockHeading)) return { text: specText, alreadyApplied: true };

  const bullets = input.findings
    .slice(0, FLOW_CALLS_MAX_FINDINGS)
    .flatMap((finding, index) => {
      const id = truncateFlowText(oneLine(finding.id ?? String(index + 1)), FLOW_CALL_ID_MAX);
      if (finding.class === 'ambiguous') {
        if (typeof finding.answer !== 'string' || oneLine(finding.answer).length === 0) return [];
        const question = truncateFlowText(oneLine(finding.question ?? ''), FLOW_CALL_TEXT_MAX);
        const answer = truncateFlowText(oneLine(finding.answer), FLOW_CALL_TEXT_MAX);
        return [`- **${id}** (answer): ${question} Answer: ${answer}`];
      }
      const summary = truncateFlowText(oneLine(finding.summary), FLOW_CALL_TEXT_MAX);
      const fix = truncateFlowText(oneLine(finding.fix ?? ''), FLOW_CALL_TEXT_MAX);
      return [`- **${id}** (${finding.class}): ${summary} Call: ${fix}`];
    });

  const heading = specText.split(/\r?\n/).includes(FLOW_CALLS_HEADING) ? '' : `${FLOW_CALLS_HEADING}\n\n`;
  const separator = specText.length === 0 ? '' : specText.endsWith('\n') ? '\n' : '\n\n';
  return {
    text: `${specText}${separator}${heading}${blockHeading}\n\n${bullets.length === 0 ? '' : `${bullets.join('\n')}\n`}`,
    alreadyApplied: false,
  };
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
