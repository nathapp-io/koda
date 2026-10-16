/**
 * Fleet S5b knowledge outcomes US-003 (3c-2-D5) — the pure `decisions.jsonl` chunker.
 *
 * AC-1..AC-7: one chunk per decision line in file order, the optional metadata lines, malformed-line
 * skipping, the shared 1c-c-D8 anchor rule and its duplicate suffix, the accepted-chunk cap and the
 * `chunkMarkdown` regression the exported anchor helpers must not change. `chunkDecisions` is a pure
 * function, so every test calls it directly (api-testing rule: no module, no database, no model).
 */
import { chunkDecisions, MAX_DECISION_CHUNKS } from './decisions-chunker';
import { chunkMarkdown, slug, uniqueAnchor, type MarkdownChunk } from './markdown-chunker';

const line = (record: unknown): string => JSON.stringify(record);
const lines = (...records: unknown[]): string => records.map(line).join('\n');
const textOf = (chunks: MarkdownChunk[]): string[] => chunks.map((chunk) => chunk.text);

/** The field shape a real advisor writes (`.nax/features/<feature>/decisions.jsonl`). */
const advisorDecision = {
  questionId: 'Q-8e4c98d6-e4aa',
  kind: 'finish-approval',
  chosenOptionId: 'A',
  action: { type: 'approve' },
  rationale: 'All 7 stories complete, final gates and CI green, branch review ran with 0 open findings.',
  confidence: 'medium',
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: '2026-10-16T05:36:54.296Z',
  model: 'claude:sonnet[medium]',
  memoryMode: 'warm',
  auditRef: 'advisor-audit/fleet-s5b-koda-knowledge-index/D-1.json',
  id: 'D-1',
};

describe('MAX_DECISION_CHUNKS', () => {
  it('is 1000, below the chunk store 2000-row read cap', () => {
    expect(MAX_DECISION_CHUNKS).toBe(1000);
  });
});

describe('chunkDecisions', () => {
  it('AC-1: answers one chunk per decision line, in file order, and chunk 0 is a decision', () => {
    const text = lines(
      { id: 'D-1', kind: 'finish-approval', chosenOptionId: 'A', action: { type: 'approve' }, rationale: 'All green. Ship it.' },
      { id: 'D-2' },
    );

    const chunks = chunkDecisions(text);

    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    expect(chunks.map((chunk) => chunk.title)).toEqual(['Decision D-1', 'Decision D-2']);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(['Decision D-1', 'Decision D-2']);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['d-1', 'd-2']);
    // No summary chunk: index 0 carries a decision, not the document title and the H2 list.
    expect(chunks[0].title).not.toBe('');
    expect(textOf(chunks).every((text) => text !== '')).toBe(true);
  });

  it('AC-2: renders the kind, chosen option and rationale lines with an extractive abstract', () => {
    const chunks = chunkDecisions(line({
      id: 'D-1', kind: 'finish-approval', chosenOptionId: 'A', action: { type: 'approve' }, rationale: 'All green. Ship it.',
    }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe([
      'Decision D-1 (finish-approval)',
      'Chosen: A -> approve',
      'Rationale: All green. Ship it.',
    ].join('\n'));
    expect(chunks[0].abstract).toBe('All green. Ship it.');
  });

  it('AC-3: appends by <model> to the Decided line and no confidence part', () => {
    const chunks = chunkDecisions(line({ id: 'D-1', decidedAt: '2026-10-16T05:36:54Z', model: 'm' }));

    expect(chunks[0].text.split('\n')).toContain('Decided: 2026-10-16T05:36:54Z by m');
  });

  it.each([
    ['a line that is not JSON', 'not json at all'],
    ['a line holding a bare JSON string', '"D-1"'],
    ['a JSON array line', '[{"id":"D-1"}]'],
    ['a JSON null line', 'null'],
    ['an object without an id', line({ kind: 'finish-approval' })],
    ['an object with a non-string id', line({ id: 1 })],
    ['an object with a null id', line({ id: null })],
    ['an object whose id is an array', line({ id: ['D-1'] })],
    ['an empty line', ''],
    ['a whitespace-only line', '   '],
  ])('AC-4: skips %s and keeps the valid lines', (_label, malformed) => {
    const chunks = chunkDecisions([malformed, line({ id: 'D-1' }), malformed].join('\n'));

    expect(chunks.map((chunk) => chunk.title)).toEqual(['Decision D-1']);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0]);
  });

  it('AC-5: suffixes a repeated anchor with -1', () => {
    const chunks = chunkDecisions(lines({ id: 'D 1' }, { id: 'd-1' }));

    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['d-1', 'd-1-1']);
  });

  it.each([
    [['D-1'], ['d-1']],
    [['D-1', 'D-1'], ['d-1', 'd-1-1']],
    [['D-1', 'D-1', 'D-1'], ['d-1', 'd-1-1', 'd-1-2']],
    [['D 1', 'd-1', 'd.1'], ['d-1', 'd-1-1', 'd1']],
    [['D_1'], ['d_1']],
    [['D #1'], ['d-1']],
    [['D-2', 'D-3'], ['d-2', 'd-3']],
  ])('AC-5: ids %j answer anchors %j under the shared 1c-c-D8 rule', (ids, expected) => {
    const chunks = chunkDecisions(lines(...ids.map((id) => ({ id }))));

    expect(chunks.map((chunk) => chunk.anchor)).toEqual(expected);
    expect(chunks.map((chunk) => chunk.anchor)).not.toContain('');
  });

  it('AC-6: keeps the first 1000 decisions and ignores the later ones', () => {
    const text = Array.from({ length: MAX_DECISION_CHUNKS + 1 }, (_value, index) => line({ id: `D-${index + 1}` })).join('\n');

    const chunks = chunkDecisions(text);

    expect(chunks).toHaveLength(1000);
    expect(chunks[0].title).toBe('Decision D-1');
    expect(chunks[chunks.length - 1].title).toBe('Decision D-1000');
    expect(chunks[chunks.length - 1].chunkIndex).toBe(999);
  });

  it('AC-7: chunkMarkdown still answers the summary chunk and the duplicate-heading suffix', () => {
    const text = ['# D 1', 'a'.repeat(300), '', '## d-1', 'b'.repeat(300)].join('\n');

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(['', 'D 1', 'D 1 > d-1']);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['', 'd-1', 'd-1-1']);
    // The exported helpers are the very rule the decisions chunker reuses.
    const counts = new Map<string, number>();
    const used = new Set<string>();
    expect(uniqueAnchor(slug('D 1'), counts, used)).toBe('d-1');
    expect(slug('D-1')).toBe('d-1');
  });

  const optionalLines: Array<[Record<string, unknown>, string[]]> = [
    [{ id: 'D-1' }, ['Decision D-1']],
    [{ id: 'D-1', kind: 'branch-fix' }, ['Decision D-1 (branch-fix)']],
    [{ id: 'D-1', questionId: 'Q-1' }, ['Decision D-1', 'Question: Q-1']],
    [{ id: 'D-1', chosenOptionId: 'B', action: { type: 'rework' } }, ['Decision D-1', 'Chosen: B -> rework']],
    [{ id: 'D-1', rationale: 'Because it is reversible.' }, ['Decision D-1', 'Rationale: Because it is reversible.']],
    [{ id: 'D-1', decidedAt: '2026-10-16T05:36:54Z' }, ['Decision D-1', 'Decided: 2026-10-16T05:36:54Z']],
    [
      { id: 'D-1', decidedAt: '2026-10-16T05:36:54Z', confidence: 'high' },
      ['Decision D-1', 'Decided: 2026-10-16T05:36:54Z, confidence high'],
    ],
    [
      { id: 'D-1', decidedAt: '2026-10-16T05:36:54Z', model: 'm', confidence: 'low' },
      ['Decision D-1', 'Decided: 2026-10-16T05:36:54Z by m, confidence low'],
    ],
  ];

  it.each(optionalLines)('renders only the lines whose values are present: %j', (record, expected) => {
    const chunks = chunkDecisions(line(record));

    expect(chunks[0].text).toBe(expected.join('\n'));
  });

  it('answers an empty array for no decision lines at all', () => {
    expect(chunkDecisions('')).toEqual([]);
    expect(chunkDecisions('not json\n\n   \n{"kind":"x"}')).toEqual([]);
  });

  it('follows the file order, not the id order', () => {
    const chunks = chunkDecisions(lines({ id: 'D-9' }, { id: 'D-2' }, { id: 'D-1' }));

    expect(chunks.map((chunk) => chunk.title)).toEqual(['Decision D-9', 'Decision D-2', 'Decision D-1']);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['d-9', 'd-2', 'd-1']);
  });

  it('renders a real advisor record into the five metadata lines', () => {
    const chunks = chunkDecisions(line(advisorDecision));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe([
      'Decision D-1 (finish-approval)',
      'Question: Q-8e4c98d6-e4aa',
      'Chosen: A -> approve',
      'Rationale: All 7 stories complete, final gates and CI green, branch review ran with 0 open findings.',
      'Decided: 2026-10-16T05:36:54.296Z by claude:sonnet[medium], confidence medium',
    ].join('\n'));
    expect(chunks[0].title).toBe('Decision D-1');
    expect(chunks[0].anchor).toBe('d-1');
    expect(chunks[0].abstract).toBe(advisorDecision.rationale);
  });

  it('ignores values that are not strings, including booleans and nested objects', () => {
    const chunks = chunkDecisions(line({
      id: 'D-1',
      kind: 7,
      questionId: {},
      chosenOptionId: ['A'],
      action: 'approve',
      rationale: false,
      decidedAt: null,
      model: 3,
      confidence: true,
    }));

    expect(chunks[0].text).toBe('Decision D-1');
    expect(chunks[0].abstract).toBe('');
  });

  it('cuts the abstract to the first 300 characters of the rationale', () => {
    const rationale = `${'r'.repeat(299)}tail`;
    const chunks = chunkDecisions(line({ id: 'D-1', rationale }));

    expect(chunks[0].abstract).toBe('r'.repeat(299) + 't');
    expect(chunks[0].abstract).toHaveLength(300);
    // The text keeps the whole rationale; only the abstract is cut.
    expect(chunks[0].text).toContain(rationale);
  });

  it('answers an empty abstract when the rationale is absent', () => {
    const chunks = chunkDecisions(line({ id: 'D-1', chosenOptionId: 'A', action: { type: 'approve' } }));

    expect(chunks[0].abstract).toBe('');
  });
});
