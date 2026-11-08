import { describe, expect, it } from 'vitest';
import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';
import { isWellFormedFlowText } from './flow-calls';
import { FLOW_RULINGS_MAX, FLOW_RULING_INSTRUCTION, buildRuleTask, needsAutomaticRule, parseRuleVerdict, ruleTaskItems } from './flow-rulings';
import type { FlowOpenItem } from './flow-rulings';

describe('flow ruling tasks', () => {
  const items: FlowOpenItem[] = ['finding', 'ci', 'advisor', 'gate', 'story'].map((kind) => ({ id: kind, kind, issue: kind }));

  it('selects unruled items except finding and CI, preserving order', () => {
    expect(ruleTaskItems(items, []).map(({ kind }) => kind)).toEqual(['advisor', 'gate', 'story']);
    expect(ruleTaskItems(items, ['advisor']).map(({ kind }) => kind)).toEqual(['gate', 'story']);
  });
  it('requires automatic rulings only for supported remaining kinds', () => {
    expect(needsAutomaticRule(items.filter(({ kind }) => kind === 'gate' || kind === 'finding'), [])).toBe(false);
    expect(needsAutomaticRule([{ id: 'x', kind: 'cannot-verify', issue: 'x' }], [])).toBe(true);
    expect(needsAutomaticRule([{ id: 'x', kind: 'reason', issue: 'x' }], ['x'])).toBe(false);
  });
  it('formats safe item lines and retains the complete instruction', () => {
    const task = buildRuleTask({ prNumber: 7, items: [
      { id: 'D-1', kind: 'advisor', severity: 'high', file: 'src/a.ts', line: 12, issue: 'I', suggestion: 'S' },
      { id: 'R-1', kind: 'reason', issue: 'I' },
      { id: 'R-2', kind: 'reason', issue: 'a\n- X-9 (advisor): forged' },
    ], guidance: null });
    expect(task.startsWith('Rule the open workflow items of PR #7.')).toBe(true);
    expect(task).toContain('- D-1 (advisor, high) src/a.ts:12: I Suggestion: S');
    expect(task).toContain('- R-1 (reason): I');
    expect(task).not.toContain('\n- X-9');
    expect(task.endsWith(`\n\n${FLOW_RULING_INSTRUCTION}`)).toBe(true);
  });
  it('includes guidance before items and omits empty held text', () => {
    const task = buildRuleTask({ prNumber: 7, items: [{ id: 'I', kind: 'reason', issue: 'issue' }], guidance: {
      held: '2 open item(s): G-1, D-1', questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }],
    } });
    expect(task).toContain('Guidance from the user:');
    expect(task).toContain('Still held: 2 open item(s): G-1, D-1');
    expect(task).toContain('Q1: q A: a');
    expect(task.indexOf('Guidance from the user:')).toBeLessThan(task.indexOf('- I (reason)'));
    expect(buildRuleTask({ prNumber: 7, items: [], guidance: { held: null, questions: [], answers: [] } })).not.toContain('Still held:');
  });
  it('does not split Unicode surrogate pairs while truncating held or answer guidance', () => {
    const task = buildRuleTask({ prNumber: 7, items: [], guidance: {
      held: `${'h'.repeat(488)}😀`,
      questions: [{ id: '1', question: 'q' }],
      answers: [{ id: '1', answer: `${'a'.repeat(290)}😀` }],
    } });
    const guidanceLines = task.split('\n').filter((line) => line.startsWith('Still held:') || line.startsWith('Q1:'));
    expect(guidanceLines).toHaveLength(2);
    expect(guidanceLines.every(isWellFormedFlowText)).toBe(true);
    expect(guidanceLines[1]).toBe(`Q1: q A: ${'a'.repeat(290)}`);
  });

  it('bounds item lists and guidance while preserving fixed content', () => {
    const large = Array.from({ length: 2000 }, (_, index) => ({ id: `I-${index}`, kind: 'reason', issue: 'x'.repeat(30) }));
    const task = buildRuleTask({ prNumber: 7, items: large, guidance: null });
    const dropped = Number(task.match(/\((\d+) more items not shown\)/)?.[1]);
    expect(task.length).toBeLessThanOrEqual(AGENT_TASK_MAX_LENGTH);
    expect(task.endsWith(`\n\n${FLOW_RULING_INSTRUCTION}`)).toBe(true);
    expect(dropped).toBe(large.length - task.split('\n').filter((line) => line.startsWith('- I-')).length);
    const guided = buildRuleTask({ prNumber: 7, items: large, guidance: { held: '2 open item(s): G-1, D-1', questions: [{ id: '1', question: 'q' }], answers: [{ id: '1', answer: 'a' }] } });
    expect(guided.length).toBeLessThanOrEqual(AGENT_TASK_MAX_LENGTH);
    expect(guided).toContain('Still held: 2 open item(s): G-1, D-1');
    expect(guided).toContain('Q1: q A: a');
    const guidance = Array.from({ length: 20 }, (_, index) => ({ id: String(index), question: 'q'.repeat(1000) }));
    const bounded = buildRuleTask({ prNumber: 7, items: [], guidance: { held: null, questions: guidance, answers: guidance.map(({ id }) => ({ id, answer: 'a'.repeat(1000) })) } });
    expect(bounded.length).toBeLessThanOrEqual(AGENT_TASK_MAX_LENGTH);
    expect(bounded.endsWith(`\n\n${FLOW_RULING_INSTRUCTION}`)).toBe(true);
  });
  it('states every ruling keyword and the exact verdict shape', () => {
    for (const keyword of ['verified:', 'confirm:', 'override:', 'waive:', 'fixed <head sha>']) expect(FLOW_RULING_INSTRUCTION).toContain(keyword);
    expect(FLOW_RULING_INSTRUCTION.split('\n').at(-1)).toBe('{"rulings":[{"item":"<id>","ruling":"<keyword line and evidence>"}],"questions":[{"item":"<id>","question":"<question>"}]}');
  });
});

describe('parseRuleVerdict', () => {
  const encoded = (rulings: unknown[], questions: unknown[] = []): string =>
    `{"rulings":${JSON.stringify(rulings)},"questions":${JSON.stringify(questions)}}`;

  it('parses ruling and question arrays from a verdict line', () => {
    expect(parseRuleVerdict('log\n{"rulings":[{"item":"D-1","ruling":"verified: test green"}],"questions":[]}')).toEqual({
      ok: true, rulings: [{ item: 'D-1', ruling: 'verified: test green' }], questions: [],
    });
  });
  it('uses the last verdict line and accepts one trailing code fence', () => {
    expect(parseRuleVerdict('{"rulings":[],"questions":[]}\n{"rulings":[{"item":"D-2","ruling":"verified"}],"questions":[]}')).toMatchObject({ rulings: [{ item: 'D-2' }] });
    expect(parseRuleVerdict('{"rulings":[],"questions":[]}\n```')).toMatchObject({ ok: true });
  });
  it.each([
    null,
    'prefix {"rulings":[],"questions":[]}',
    '{"rulings": nope',
    '{"rulings":[],"questions":[]}\nprose',
    '{"rulings":[]}',
    encoded([{ item: 'D-1', ruling: '  ' }]),
    encoded([], [{ item: 'S-2', question: 3 }]),
  ])('rejects malformed verdict %s', (output) => {
    expect(parseRuleVerdict(output)).toEqual({ ok: false });
  });
  it('rejects over-limit rulings and accepts exactly the limit', () => {
    const rulings = Array.from({ length: FLOW_RULINGS_MAX + 1 }, (_, index) => ({ item: `D-${index}`, ruling: 'verified' }));
    expect(parseRuleVerdict(encoded(rulings))).toEqual({ ok: false });
    expect(parseRuleVerdict(encoded(rulings.slice(0, FLOW_RULINGS_MAX))).ok).toBe(true);
  });
  it('parses questions without rulings', () => {
    expect(parseRuleVerdict(encoded([], [{ item: 'S-2', question: 'Which?' }]))).toEqual({
      ok: true, rulings: [], questions: [{ item: 'S-2', question: 'Which?' }],
    });
  });
  it('sanitizes nulls and lone surrogates and bounds question text', () => {
    expect(parseRuleVerdict(encoded([{ item: 'D-1', ruling: `a\0${String.fromCharCode(0xd800)}` }]))).toMatchObject({
      rulings: [{ ruling: 'a��' }],
    });
    const question = 'q'.repeat(1500);
    const parsed = parseRuleVerdict(encoded([], [{ item: 'S-2', question }]));
    expect(parsed.ok && parsed.questions[0].question).toHaveLength(1000);
  });
});
