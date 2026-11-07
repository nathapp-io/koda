import { describe, expect, it } from 'vitest';
import { FLOW_CALL_TEXT_MAX, flowQuestions, formatQuestionsComment, truncateFlowText } from './flow-calls';
import type { FlowFinding } from './flow-verdict';

/** True when every surrogate in the text belongs to a pair, as PostgreSQL JSONB requires. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

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

  it('never cuts a surrogate pair in half', () => {
    // 999 ASCII characters then an astral emoji: a naive slice(0, 1000) keeps the lone high
    // surrogate, which PostgreSQL JSONB rejects when the questions are stored.
    const question = flowQuestions([{
      class: 'ambiguous', summary: 's', question: 'a'.repeat(FLOW_CALL_TEXT_MAX - 1) + '😀',
    }])[0]?.question ?? '';
    expect(question).toBe('a'.repeat(FLOW_CALL_TEXT_MAX - 1));
    expect(question.length).toBeLessThanOrEqual(FLOW_CALL_TEXT_MAX);
    expect(isWellFormed(question)).toBe(true);
  });

  it('keeps a surrogate pair that ends exactly on the bound', () => {
    const emoji = '😀';
    const question = flowQuestions([{
      class: 'ambiguous', summary: 's', question: 'a'.repeat(FLOW_CALL_TEXT_MAX - 2) + emoji,
    }])[0]?.question ?? '';
    expect(question).toBe('a'.repeat(FLOW_CALL_TEXT_MAX - 2) + emoji);
    expect(isWellFormed(question)).toBe(true);
  });
});

describe('truncateFlowText', () => {
  it('cuts at the bound without splitting a surrogate pair', () => {
    expect(truncateFlowText('a'.repeat(10), 4)).toBe('aaaa');
    expect(truncateFlowText('a'.repeat(3) + '😀', 4)).toBe('aaa');
    expect(truncateFlowText('a'.repeat(2) + '😀', 4)).toBe('aa😀');
    expect(truncateFlowText('short', 100)).toBe('short');
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
