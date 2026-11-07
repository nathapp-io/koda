import { describe, expect, it } from 'vitest';
import { FLOW_CALL_TEXT_MAX, flowQuestions, formatQuestionsComment } from './flow-calls';
import type { FlowFinding } from './flow-verdict';

describe('flowQuestions', () => {
  it('uses finding positions and preserves verdict order', () => {
    const findings: FlowFinding[] = [
      { class: 'minor', summary: 'm', fix: 'f' },
      { class: 'ambiguous', summary: 'a', question: 'Q1' },
      { class: 'answered', summary: 'd', fix: 'f' },
      { class: 'ambiguous', summary: 'b', question: 'Q2' },
    ];
    expect(flowQuestions(findings)).toEqual([{ id: '2', question: 'Q1' }, { id: '4', question: 'Q2' }]);
  });

  it('does not use the reviewer finding id', () => {
    expect(flowQuestions([{ id: 'api-shape', class: 'ambiguous', summary: 's', question: 'Q' }]))
      .toEqual([{ id: '1', question: 'Q' }]);
  });

  it('collapses whitespace and caps question text', () => {
    expect(flowQuestions([{ class: 'ambiguous', summary: 's', question: ' first\n   second ' }]))
      .toEqual([{ id: '1', question: 'first second' }]);
    expect(flowQuestions([{ class: 'ambiguous', summary: 's', question: 'q'.repeat(1500) }])[0]?.question)
      .toHaveLength(FLOW_CALL_TEXT_MAX);
  });

  it('returns no entries without ambiguous findings', () => {
    expect(flowQuestions([{ class: 'minor', summary: 's', fix: 'f' }])).toEqual([]);
  });
});

describe('formatQuestionsComment', () => {
  it('formats all questions and uses the first positional id in the example', () => {
    expect(formatQuestionsComment({
      step: 'SPEC_REVIEW', jobId: 'j1',
      questions: [{ id: '2', question: 'Q1' }, { id: '5', question: 'Q2' }],
      answerPath: '/api/projects/sandbox/flows/f1/answers',
    })).toBe([
      'Flow needs answers (SPEC_REVIEW job j1):',
      '2. Q1',
      '5. Q2',
      'Answer every question with POST /api/projects/sandbox/flows/f1/answers and the body {"jobId":"j1","answers":[{"id":"2","answer":"..."}]}.',
    ].join('\n'));
  });
});
