import { describe, expect, it, vi } from 'vitest';
import { formatFindings, parseFlowVerdict } from './flow-verdict';
import * as prdEditsModule from './flow-prd-edits';

vi.mock('./flow-prd-edits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flow-prd-edits')>();
  return { ...actual, parsePrdEdits: vi.fn(actual.parsePrdEdits) };
});

describe('classified flow verdicts', () => {
  it('accepts valid classified findings and rejects missing or invalid class-specific text', () => {
    expect(parseFlowVerdict('ok\n{"findings":[{"id":"F1","class":"minor","summary":"s","fix":"f"}]}')).toEqual({ ok: true, findings: [{ id: 'F1', class: 'minor', summary: 's', fix: 'f' }], prdEdits: [] });
    expect(parseFlowVerdict('{"findings":[{"class":"ambiguous","summary":"s","question":"q"}]}')).toEqual({ ok: true, findings: [{ class: 'ambiguous', summary: 's', question: 'q' }], prdEdits: [] });
    expect(parseFlowVerdict('{"findings":[{"class":"answered","summary":"s","fix":"f"}]}')).toMatchObject({ ok: true, findings: [{ class: 'answered' }] });
    for (const verdict of ['{"findings":[{"summary":"s"}]}', '{"findings":[{"class":"major","summary":"s","fix":"f"}]}', '{"findings":[{"class":"ambiguous","summary":"s"}]}']) {
      expect(parseFlowVerdict(verdict)).toMatchObject({ ok: false });
    }
    expect(parseFlowVerdict('{"findings":[]}')).toEqual({ ok: true, findings: [], prdEdits: [] });
    expect(parseFlowVerdict('{"findings":[],"prdEdits":[{"story":"US-001","op":"add_ac","new":"n"}]}'))
      .toEqual({ ok: true, findings: [], prdEdits: [{ story: 'US-001', op: 'add_ac', new: 'n' }] });
  });

  it('US-007 AC-1: keeps the feature a finding names', () => {
    expect(parseFlowVerdict('{"findings":[{"class":"minor","summary":"s","fix":"f","feature":"b"}]}')).toEqual({
      ok: true, findings: [{ class: 'minor', summary: 's', fix: 'f', feature: 'b' }], prdEdits: [],
    });
  });

  it('US-007 AC-2: drops a non-string feature and keeps the finding', () => {
    for (const feature of [12, null, {}, []]) {
      expect(parseFlowVerdict(JSON.stringify({ findings: [{ class: 'minor', summary: 's', fix: 'f', feature }] }))).toEqual({
        ok: true, findings: [{ class: 'minor', summary: 's', fix: 'f' }], prdEdits: [],
      });
    }
  });

  it('#415 drops an answered or minor finding with no fix as a note and counts it', () => {
    const output = JSON.stringify({ findings: [
      { id: 'F1', class: 'minor', summary: 's1', fix: 'f1' },
      { id: 'N1', class: 'answered', summary: 'already settled', fix: '' },
      { id: 'N2', class: 'minor', summary: 'no change' },
      { id: 'N3', class: 'answered', summary: 'blank', fix: '   ' },
    ] });
    expect(parseFlowVerdict(output)).toEqual({
      ok: true, findings: [{ id: 'F1', class: 'minor', summary: 's1', fix: 'f1' }], prdEdits: [], notes: 3,
    });
  });

  it('#415 a verdict whose every finding is a note is clean', () => {
    expect(parseFlowVerdict('{"findings":[{"class":"answered","summary":"s","fix":""}]}'))
      .toEqual({ ok: true, findings: [], prdEdits: [], notes: 1 });
  });

  it('#415 an ambiguous finding with no question still makes the verdict unreadable', () => {
    expect(parseFlowVerdict('{"findings":[{"class":"minor","summary":"s","fix":"f"},{"class":"ambiguous","summary":"s","question":" "}]}'))
      .toEqual({ ok: false, reason: 'finding 2 has no question' });
  });

  it.each([
    ['All fine', 'no verdict line'],
    ['{"findings":[}', 'verdict is not valid JSON'],
    ['{"findings":{"a":1}}', 'findings is not a list'],
    ['{"findings":[{"summary":"s"}]}', 'finding 1 has no valid class'],
    ['{"findings":["bad"]}', 'finding 1 is not an object with a summary'],
  ])('#415 names why %s is unreadable', (output, reason) => {
    expect(parseFlowVerdict(output)).toEqual({ ok: false, reason });
  });

  it('#415 names a rejected PRD edit payload', () => {
    vi.mocked(prdEditsModule.parsePrdEdits).mockReturnValueOnce(null);
    expect(parseFlowVerdict('{"findings":[],"prdEdits":[]}')).toEqual({ ok: false, reason: 'prdEdits is invalid' });
  });

  it('rejects a present PRD edit payload when the edit parser rejects it', () => {
    vi.mocked(prdEditsModule.parsePrdEdits).mockReturnValueOnce(null);
    expect(parseFlowVerdict('{"findings":[],"prdEdits":[]}')).toMatchObject({ ok: false });
  });

  it('drops an answer supplied by the verdict', () => {
    const result = parseFlowVerdict('{"findings":[{"class":"ambiguous","summary":"s","question":"q","answer":"untrusted"}] }');
    expect(result).toEqual({ ok: true, findings: [{ class: 'ambiguous', summary: 's', question: 'q' }], prdEdits: [] });
  });

  it('preserves final-verdict, malformed and trailing-text rejection behavior', () => {
    expect(parseFlowVerdict('Review\n{"findings":[{"id":"F1","class":"minor","summary":"s","fix":"f"}]}')).toMatchObject({ ok: true });
    expect(parseFlowVerdict('{"findings":[]} thanks')).toMatchObject({ ok: false });
    expect(parseFlowVerdict('{"findings":{"a":1}}')).toMatchObject({ ok: false });
    expect(parseFlowVerdict('All fine')).toMatchObject({ ok: false });
    expect(parseFlowVerdict(null)).toEqual({ ok: false, reason: 'no agent output' });
  });

  it('selects the final marker rather than an earlier example', () => {
    expect(parseFlowVerdict('{"findings":[{"class":"minor","summary":"example","fix":"f"}]}\nActual verdict:\n{"findings":[]}'))
      .toEqual({ ok: true, findings: [], prdEdits: [] });
    expect(parseFlowVerdict('{"findings":[]}\n{"findings":[')).toMatchObject({ ok: false });
  });

  it('accepts the final verdict inside a code fence', () => {
    expect(parseFlowVerdict('Review\n```json\n{"findings":[]}\n```\n')).toEqual({ ok: true, findings: [], prdEdits: [] });
  });

  it.each(['{"findings":[}', '{"findings":[]', '{"findings":[null]}', '{"findings":["bad"]}'])(
    'rejects malformed JSON or findings: %s', (output) => {
      expect(parseFlowVerdict(output)).toMatchObject({ ok: false });
    },
  );

  it.each([undefined, null, 12, {}, []])('rejects invalid summary %j', (summary) => {
    expect(parseFlowVerdict(JSON.stringify({ findings: [{ class: 'minor', summary, fix: 'f' }] }))).toMatchObject({ ok: false });
  });

  it.each([null, 12, {}, []])('ignores non-string id %j', (id) => {
    expect(parseFlowVerdict(JSON.stringify({ findings: [{ id, class: 'minor', summary: 's', fix: 'f' }] })))
      .toEqual({ ok: true, findings: [{ class: 'minor', summary: 's', fix: 'f' }], prdEdits: [] });
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
