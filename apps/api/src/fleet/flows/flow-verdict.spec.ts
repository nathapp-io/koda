import { describe, expect, it } from 'vitest';
import { formatFindings, parseFlowVerdict } from './flow-verdict';

describe('classified flow verdicts', () => {
  it('accepts valid classified findings and rejects missing or invalid class-specific text', () => {
    expect(parseFlowVerdict('ok\n{"findings":[{"id":"F1","class":"minor","summary":"s","fix":"f"}]}')).toEqual({ ok: true, findings: [{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }] });
    expect(parseFlowVerdict('{"findings":[{"class":"ambiguous","summary":"s","question":"q"}]}')).toEqual({ ok: true, findings: [{ class: 'ambiguous', summary: 's', question: 'q' }] });
    expect(parseFlowVerdict('{"findings":[{"class":"answered","summary":"s","fix":"f"}]}')).toMatchObject({ ok: true, findings: [{ class: 'answered' }] });
    for (const verdict of ['{"findings":[{"summary":"s"}]}', '{"findings":[{"class":"major","summary":"s","fix":"f"}]}', '{"findings":[{"class":"minor","summary":"s"}]}', '{"findings":[{"class":"answered","summary":"s","fix":"   "}]}', '{"findings":[{"class":"ambiguous","summary":"s"}]}']) {
      expect(parseFlowVerdict(verdict)).toEqual({ ok: false });
    }
    expect(parseFlowVerdict('{"findings":[]}')).toEqual({ ok: true, findings: [] });
  });

  it('preserves final-verdict, malformed and trailing-text rejection behavior', () => {
    expect(parseFlowVerdict('Review\n{"findings":[{"id":"F1","class":"minor","summary":"s","fix":"f"}]}')).toMatchObject({ ok: true });
    expect(parseFlowVerdict('{"findings":[]} thanks')).toEqual({ ok: false });
    expect(parseFlowVerdict('{"findings":{"a":1}}')).toEqual({ ok: false });
    expect(parseFlowVerdict('All fine')).toEqual({ ok: false });
    expect(parseFlowVerdict(null)).toEqual({ ok: false });
  });

  it('selects the final marker rather than an earlier example', () => {
    expect(parseFlowVerdict('{"findings":[{"class":"minor","summary":"example","fix":"f"}]}\nActual verdict:\n{"findings":[]}'))
      .toEqual({ ok: true, findings: [] });
    expect(parseFlowVerdict('{"findings":[]}\n{"findings":[')).toEqual({ ok: false });
  });

  it('accepts the final verdict inside a code fence', () => {
    expect(parseFlowVerdict('Review\n```json\n{"findings":[]}\n```\n')).toEqual({ ok: true, findings: [] });
  });

  it.each(['{"findings":[}', '{"findings":[]', '{"findings":[null]}', '{"findings":["bad"]}'])(
    'rejects malformed JSON or findings: %s', (output) => {
      expect(parseFlowVerdict(output)).toEqual({ ok: false });
    },
  );

  it.each([undefined, null, 12, {}, []])('rejects invalid summary %j', (summary) => {
    expect(parseFlowVerdict(JSON.stringify({ findings: [{ class: 'minor', summary, fix: 'f' }] }))).toEqual({ ok: false });
  });

  it.each([null, 12, {}, []])('ignores non-string id %j', (id) => {
    expect(parseFlowVerdict(JSON.stringify({ findings: [{ id, class: 'minor', summary: 's', fix: 'f' }] })))
      .toEqual({ ok: true, findings: [{ class: 'minor', summary: 's', fix: 'f' }] });
  });

  it('formats plural findings with consecutive positions', () => {
    expect(formatFindings([
      { id: 'F1', class: 'minor', summary: 'S1', fix: 'f' },
      { class: 'answered', summary: 'S2', fix: 'f' },
    ])).toBe('2 findings: 1. [F1] (minor) S1 2. (answered) S2');
    expect(formatFindings([])).toBe('0 findings: ');
  });

  it('formats classifications and keeps the exact detail cap', () => {
    expect(formatFindings([{ id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' }])).toBe('1 finding: 1. [F1] (minor) Missing AC');
    expect(formatFindings([{ class: 'answered', summary: 'S', fix: 'f' }])).toBe('1 finding: 1. (answered) S');
    const result = formatFindings(Array.from({ length: 100 }, () => ({ class: 'minor' as const, summary: 'x'.repeat(100), fix: 'f' })));
    expect(result).toHaveLength(2000);
    expect(result.endsWith('…')).toBe(true);
  });
});
