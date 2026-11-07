import { describe, expect, it } from 'vitest';
import { formatFindings, parseFlowVerdict } from './flow-verdict';

describe('parseFlowVerdict', () => {
  it('AC-1: parses an empty final verdict after prose', () => {
    expect(parseFlowVerdict('Looks good.\n{"findings":[]}')).toEqual({ ok: true, findings: [] });
  });
  it('AC-2: parses findings and preserves string ids', () => {
    expect(parseFlowVerdict('Review\n{"findings":[{"id":"F1","summary":"Missing AC for 409"}]}')).toEqual({ ok: true, findings: [{ id: 'F1', summary: 'Missing AC for 409' }] });
  });
  it('AC-3: parses only the final findings marker', () => {
    expect(parseFlowVerdict('{"findings":[{"summary":"x"}]}\nmore text\n{"findings":[]}')).toEqual({ ok: true, findings: [] });
  });
  it('AC-4: removes a trailing code fence and whitespace', () => {
    expect(parseFlowVerdict('{"findings":[]}\n```\n  ')).toEqual({ ok: true, findings: [] });
  });
  it('AC-5: rejects text after the verdict', () => {
    expect(parseFlowVerdict('{"findings":[]} thanks')).toEqual({ ok: false });
  });
  it('AC-6: rejects output without JSON', () => {
    expect(parseFlowVerdict('All fine, no JSON.')).toEqual({ ok: false });
  });
  it('AC-7: rejects null', () => {
    expect(parseFlowVerdict(null)).toEqual({ ok: false });
  });
  it('AC-8: rejects malformed JSON', () => {
    expect(parseFlowVerdict('{"findings": oops')).toEqual({ ok: false });
  });
  it('AC-9: rejects a non-array findings value', () => {
    expect(parseFlowVerdict('{"findings":{"a":1}}')).toEqual({ ok: false });
  });
  it('AC-10: rejects entries without a string summary', () => {
    expect(parseFlowVerdict('{"findings":[{"id":"F1"}]}')).toEqual({ ok: false });
  });
  it('AC-11: omits non-string ids', () => {
    expect(parseFlowVerdict('{"findings":[{"id":7,"summary":"s"}]}')).toEqual({ ok: true, findings: [{ summary: 's' }] });
  });
});

describe('formatFindings', () => {
  it('AC-12: formats numbered findings and optional ids', () => {
    expect(formatFindings([{ id: 'F1', summary: 'a' }, { summary: 'b' }])).toBe('2 findings: 1. [F1] a 2. b');
  });
  it('AC-13: uses the singular label', () => {
    expect(formatFindings([{ summary: 'a' }])).toBe('1 finding: 1. a');
  });
  it('AC-14: truncates overlong details to the exact limit with an ellipsis', () => {
    const result = formatFindings(Array.from({ length: 100 }, () => ({ summary: 'x'.repeat(100) })));
    expect(result).toHaveLength(2000);
    expect(result.endsWith('…')).toBe(true);
  });
});
