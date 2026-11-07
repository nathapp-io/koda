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

export function flowQuestions(findings: FlowFinding[]): FlowQuestion[] {
  return findings.flatMap((finding, index) => finding.class === 'ambiguous'
    ? [{ id: String(index + 1), question: oneLine(finding.question ?? '').slice(0, FLOW_CALL_TEXT_MAX) }]
    : []);
}

export function formatQuestionsComment(input: {
  step: 'SPEC_REVIEW' | 'PRD_REVIEW';
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
  return `${result.slice(0, FLOW_QUESTIONS_MAX - 1)}…`;
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
      const id = oneLine(finding.id ?? String(index + 1)).slice(0, FLOW_CALL_ID_MAX);
      if (finding.class === 'ambiguous') {
        if (typeof finding.answer !== 'string' || oneLine(finding.answer).length === 0) return [];
        const question = oneLine(finding.question ?? '').slice(0, FLOW_CALL_TEXT_MAX);
        const answer = oneLine(finding.answer).slice(0, FLOW_CALL_TEXT_MAX);
        return [`- **${id}** (answer): ${question} Answer: ${answer}`];
      }
      const summary = oneLine(finding.summary).slice(0, FLOW_CALL_TEXT_MAX);
      const fix = oneLine(finding.fix ?? '').slice(0, FLOW_CALL_TEXT_MAX);
      return [`- **${id}** (${finding.class}): ${summary} Call: ${fix}`];
    });

  const heading = specText.split(/\r?\n/).includes(FLOW_CALLS_HEADING) ? '' : `${FLOW_CALLS_HEADING}\n\n`;
  const separator = specText.length === 0 ? '' : specText.endsWith('\n') ? '\n' : '\n\n';
  return {
    text: `${specText}${separator}${heading}${blockHeading}\n\n${bullets.length === 0 ? '' : `${bullets.join('\n')}\n`}`,
    alreadyApplied: false,
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
