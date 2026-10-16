/**
 * Fleet S5b knowledge index US-003 — the deterministic Markdown heading chunker (1c-c-D8).
 *
 * AC-1..AC-15: sections and heading paths, fenced code, front matter, the file-name title, the
 * short-section merge in both directions, the 2000-character split, the anchor slug and its
 * `-1` suffix, the extractive abstract, the pre-heading section and `\r\n` normalisation.
 * `chunkMarkdown` is a pure function, so every test calls it directly (api-testing rule).
 */
import { chunkMarkdown, type MarkdownChunk } from './markdown-chunker';

const FENCE = '```';
const TILDE_FENCE = '~~~';
const SHORT_TEXT = 'y'.repeat(150);

const lines = (...parts: string[]): string => parts.join('\n');
/** One paragraph well over the 200-character short-section threshold. */
const long = (word: string): string => `${word} ${'x'.repeat(290)}`;
const headingPaths = (chunks: MarkdownChunk[]): string[] => chunks.map((chunk) => chunk.headingPath);
const sections = (chunks: MarkdownChunk[]): MarkdownChunk[] => chunks.filter((chunk) => chunk.chunkIndex > 0);

describe('chunkMarkdown', () => {
  it('AC-1: chunks H1/H2 sections and summarises the H2 titles in chunk 0', () => {
    const text = lines('# Alpha', '', long('alpha'), '', '## Beta', '', long('beta'), '', '## Gamma', '', long('gamma'));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].headingPath).toBe('');
    expect(chunks[0].anchor).toBe('');
    expect(chunks[0].text).toContain('Sections: Beta; Gamma');
    expect(headingPaths(chunks)).toEqual(['', 'Alpha', 'Alpha > Beta', 'Alpha > Gamma']);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2, 3]);
  });

  it.each([
    ['three backticks', FENCE],
    ['three tildes', TILDE_FENCE],
  ])('AC-2: a heading inside a %s block starts no section', (_label, fence) => {
    const text = lines(
      '# Top', '', long('top'), '',
      fence, '## Not a heading', fence, '',
      long('tail'), '',
      '## Real', '', long('real'),
    );

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(headingPaths(chunks)).toEqual(['', 'Top', 'Top > Real']);
    // The fenced line is ordinary text of the Top section, never a heading.
    expect(chunks[1].text).toContain('## Not a heading');
  });

  const decision = lines(
    '---', 'title: Decision 7', 'status: superseded', 'superseded-by: docs/adr/0009.md', '---',
    '', '# Decision', '', long('context'), '', '## Consequences', '', long('consequence'),
  );

  it('AC-3: reads the front matter title, status and superseded-by and copies them onto every chunk', () => {
    const chunks = chunkMarkdown({ path: 'docs/adr/0007.md', text: decision });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.title).toBe('Decision 7');
      expect(chunk.status).toBe('superseded');
      expect(chunk.supersededBy).toBe('docs/adr/0009.md');
    }
  });

  it('AC-4: removes the front matter block from the body', () => {
    const chunks = chunkMarkdown({ path: 'docs/adr/0007.md', text: decision });

    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('title: Decision 7');
      expect(chunk.text).not.toContain('status: superseded');
      expect(chunk.text).not.toContain('superseded-by: docs/adr/0009.md');
      expect(chunk.text.split('\n')).not.toContain('---');
    }
  });

  it('AC-5: falls back to the file name without .md when there is no front matter and no H1', () => {
    const chunks = chunkMarkdown({ path: 'docs/guide-x.md', text: lines(long('intro'), '', '## Section', '', long('body')) });

    expect(chunks[0].title).toBe('guide-x');
    expect(chunks.every((chunk) => chunk.title === 'guide-x')).toBe(true);
    // Only the pre-heading text carries the title; an H2 with no H1 above it is its own path.
    expect(headingPaths(chunks)).toEqual(['', 'guide-x', 'Section']);
  });

  it('AC-6: merges a 150-character section forward into the following section', () => {
    const text = lines('# Top', '', long('top'), '', '## Short', '', SHORT_TEXT, '', '## Long', '', long('long'));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(headingPaths(chunks)).toEqual(['', 'Top', 'Top > Long']);
    expect(chunks[2].anchor).toBe('long');
    expect(chunks[2].text.startsWith(lines('## Short', '', SHORT_TEXT))).toBe(true);
    expect(chunks[2].text).toContain(lines('## Long', '', long('long')));
  });

  it('AC-7: merges a trailing 150-character section backward into the previous section', () => {
    const text = lines('# Top', '', long('top'), '', '## Tail', '', SHORT_TEXT);

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(headingPaths(chunks)).toEqual(['', 'Top']);
    expect(chunks[1].anchor).toBe('top');
    expect(chunks[1].text.endsWith(lines('## Tail', '', SHORT_TEXT))).toBe(true);
  });

  it('AC-8: splits a 5000-character section of 500-character paragraphs into parts of at most 2000 characters', () => {
    const paragraph = 'p'.repeat(500);
    const text = lines('## Big', '', Array.from({ length: 10 }, () => paragraph).join('\n\n'));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });
    const parts = sections(chunks);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(2000);
      expect(part.headingPath).toBe('Big');
      expect(part.anchor).toBe('big');
    }
    // The parts cover the section exactly once.
    expect(parts.map((part) => part.text).join('\n\n')).toBe(text);
  });

  it('AC-9: splits a single 3000-character paragraph into capped chunks', () => {
    const paragraph = 'p'.repeat(3000);

    const chunks = chunkMarkdown({ path: 'docs/a.md', text: paragraph });

    expect(sections(chunks).map((part) => part.text.length)).toEqual([2000, 1000]);
    expect(sections(chunks).map((part) => part.text).join('')).toBe(paragraph);
  });

  it('AC-9: keeps the heading with its oversized paragraph instead of emitting a heading-only chunk', () => {
    const paragraph = 'p'.repeat(3000);

    const chunks = chunkMarkdown({ path: 'docs/a.md', text: lines('## Big', '', paragraph) });

    expect(chunks[1].text.startsWith('## Big\n\n')).toBe(true);
    expect(sections(chunks).every((part) => part.text.length <= 2000 && part.text !== '## Big')).toBe(true);
    expect(chunks[1].headingPath).toBe('Big');
  });

  it('AC-10: slugs a heading with punctuation and an ampersand', () => {
    const text = lines('# Top', '', long('top'), '', '## Token Broker: cache & reuse', '', long('broker'));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks[2].headingPath).toBe('Top > Token Broker: cache & reuse');
    expect(chunks[2].anchor).toBe('token-broker-cache--reuse');
  });

  it('AC-11: suffixes the second occurrence of an anchor with -1', () => {
    const text = lines('# Top', '', long('top'), '', '## Notes', '', long('one'), '', '## Notes', '', long('two'));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks.slice(1).map((chunk) => [chunk.headingPath, chunk.anchor])).toEqual([
      ['Top', 'top'],
      ['Top > Notes', 'notes'],
      ['Top > Notes', 'notes-1'],
    ]);
  });

  it('AC-12: takes the first two sentences as the abstract', () => {
    const text = lines('## Notes', '', `First sentence. Second one! Third. ${'x'.repeat(340)}`);

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks[1].text.length).toBeGreaterThan(200);
    expect(chunks[1].abstract).toBe('First sentence. Second one!');
  });

  it('AC-13: skips a fenced block and a list marker before taking the abstract', () => {
    const text = lines('## Cache', '', FENCE, 'const a = 1;', FENCE, '', '- Item one. Done.', '', 'x'.repeat(300));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks[1].abstract).toBe('Item one. Done.');
  });

  it('AC-14: makes the text before the first heading a section carrying the title, and puts the description in chunk 0', () => {
    const intro = long('intro');
    const text = lines(
      '---', 'title: Decision 7', 'description: A decision about the cache.', '---',
      '', intro, '', '## Section', '', long('body'),
    );

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });

    expect(chunks[1].headingPath).toBe('Decision 7');
    expect(chunks[1].text).toBe(intro);
    expect(chunks[0].text).toContain('A decision about the cache.');
    expect(chunks[0].headingPath).toBe('');
  });

  it('AC-14: falls back to the first paragraph of the first section for chunk 0 without a description', () => {
    const intro = long('intro');

    const chunks = chunkMarkdown({ path: 'docs/a.md', text: lines('# Top', '', intro) });

    expect(chunks[0].text).toContain(intro);
  });

  it('AC-15: normalises \\r\\n and drops trailing hashes from a heading', () => {
    const text = lines('# Top', '', long('top'), '', '## Notes ##', '', long('notes'));
    const crlf = text.replace(/\n/g, '\r\n');

    expect(chunkMarkdown({ path: 'docs/a.md', text: crlf })).toEqual(chunkMarkdown({ path: 'docs/a.md', text }));

    const chunks = chunkMarkdown({ path: 'docs/a.md', text });
    expect(chunks[2].headingPath).toBe('Top > Notes');
    expect(chunks[2].anchor).toBe('notes');
  });

  it('returns only chunk 0, holding the title, for empty text', () => {
    const chunks = chunkMarkdown({ path: 'docs/empty.md', text: '' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, title: 'empty', headingPath: '', anchor: '', text: 'empty\nSections: ' });
  });

  it('treats a front matter block with no closing --- line as ordinary text', () => {
    const chunks = chunkMarkdown({ path: 'docs/a.md', text: lines('---', 'title: not taken', '', long('body')) });

    expect(chunks[0].title).toBe('a');
    expect(chunks[1].text).toContain('title: not taken');
  });

  it('never carries status or supersededBy keys without front matter', () => {
    const chunks = chunkMarkdown({ path: 'docs/a.md', text: lines('# Top', '', long('top')) });

    for (const chunk of chunks) {
      expect(chunk).not.toHaveProperty('status');
      expect(chunk).not.toHaveProperty('supersededBy');
    }
  });
});

describe('chunkMarkdown cap edge cases', () => {
  it.each([FENCE, TILDE_FENCE])('balances %s fences after prose, preserving mixed markers and body lines', (marker) => {
    const other = marker === FENCE ? TILDE_FENCE : FENCE;
    const body = Array.from({ length: 180 }, (_, i) => i === 80 ? other : `${i}${'x'.repeat(30)}`);
    const chunks = sections(chunkMarkdown({ path: 'a.md', text: lines('prose', `${marker}ts`, ...body, marker, 'tail') }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((part) => part.text.length <= 2000)).toBe(true);
    expect(chunks[0].text.startsWith(`prose\n${marker}ts\n`)).toBe(true);
    expect(chunks[chunks.length - 1].text.endsWith(`\n${marker}\ntail`)).toBe(true);
    expect(chunks.flatMap((part) => part.text.split('\n').filter((line) => !['prose', 'tail', marker, `${marker}ts`].includes(line)))).toEqual(body);
  });

  it('keeps surrogate pairs intact inside a long fenced line', () => {
    const body = `${'a'.repeat(1989)}😀${'b'.repeat(2200)}`;
    const parts = sections(chunkMarkdown({ path: 'a.md', text: lines(`${FENCE}ts`, body, FENCE) }));
    expect(parts[0].text).toHaveLength(1999);
    expect(parts[1].text.startsWith(`${FENCE}ts\n😀`)).toBe(true);
    expect(parts.map((part) => part.text.split('\n').slice(1, -1).join('\n')).join('')).toBe(body);
  });

  it('cuts the summary before a surrogate pair that straddles its cap', () => {
    const description = `${'a'.repeat(1995)}😀tail`;
    const chunks = chunkMarkdown({ path: 'a.md', text: lines('---', `description: ${description}`, '---', 'body') });
    expect(chunks[0].text).toBe(`a\n${'a'.repeat(1995)}😀t`);
    const boundary = chunkMarkdown({ path: 'a.md', text: lines('---', `description: ${'a'.repeat(1997)}😀tail`, '---', 'body') });
    expect(boundary[0].text).toBe(`a\n${'a'.repeat(1997)}`);
  });

  it.each([1994, 2003])('caps literal slices when a %i-character fence delimiter cannot fit with wrappers', (length) => {
    const text = lines(`${FENCE}${'x'.repeat(length - FENCE.length)}`, 'body'.repeat(1000), FENCE);
    const parts = sections(chunkMarkdown({ path: 'a.md', text }));
    expect(parts.every((part) => part.text.length <= 2000)).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts[0].text).toHaveLength(2000);
  });
});

describe('chunkMarkdown hard cap (US-001)', () => {
  const chunk = (text: string): MarkdownChunk[] => chunkMarkdown({ path: 'docs/cap.md', text });
  const list = lines('## List', ...Array.from({ length: 300 }, (_, i) => `- ${String(i).padStart(3, '0')}${'x'.repeat(35)}`));
  const body = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(27)}`);
  const fenced = lines(`${FENCE}ts`, ...body, FENCE);
  const headings = Array.from({ length: 400 }, (_, i) => `## ${String(i).padStart(3, '0')}${'h'.repeat(17)}`).join('\n');
  const capped = (chunks: MarkdownChunk[]): void => {
    expect(chunks.length).toBeGreaterThan(1);
    for (const part of chunks) expect(part.text.length).toBeLessThanOrEqual(2000);
  };

  it('AC-1: caps a blank-line-free list and preserves its lines', () => {
    const parts = sections(chunk(list));
    capped(parts);
    expect(parts.map((part) => part.text).join('\n')).toBe(list);
  });

  it('AC-2: slices a 5000-character line in order', () => {
    const text = 'x'.repeat(5000);
    const parts = sections(chunk(text));
    expect(parts.map((part) => part.text.length)).toEqual([2000, 2000, 1000]);
    expect(parts.map((part) => part.text).join('')).toBe(text);
  });

  it('AC-3: closes and reopens every fenced part within the cap', () => {
    const parts = sections(chunk(fenced));
    capped(parts);
    for (const part of parts) {
      expect(part.text.startsWith(`${FENCE}ts\n`)).toBe(true);
      expect(part.text.endsWith(`\n${FENCE}`)).toBe(true);
    }
  });

  it('AC-4: preserves all fenced body lines in order', () => {
    const parts = sections(chunk(fenced));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => part.text.split('\n').slice(1, -1))).toEqual(body);
  });

  it('AC-5: never splits an emoji surrogate pair', () => {
    const text = `${'a'.repeat(1999)}😀${'a'.repeat(100)}`;
    const parts = sections(chunk(text));
    expect(parts[0].text).toHaveLength(1999);
    expect(parts[1].text.startsWith('😀')).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe(text);
  });

  it('AC-6: caps a summary containing 400 H2 titles', () => {
    expect(chunk(headings)[0].text).toHaveLength(2000);
  });

  it('AC-7: keeps ordinary paragraph packing at blank lines', () => {
    const text = Array.from({ length: 10 }, () => 'p'.repeat(500)).join('\n\n');
    const parts = sections(chunk(text));
    capped(parts);
    expect(parts.map((part) => part.text).join('\n\n')).toBe(text);
    for (const part of parts) expect(part.text.split('\n\n').every((paragraph) => paragraph.length === 500)).toBe(true);
  });

  it('AC-8: keeps the heading attached to the oversized paragraph', () => {
    const parts = sections(chunk(lines('## Big', '', 'p'.repeat(3000))));
    capped(parts);
    expect(parts[0].text.startsWith('## Big\n\n')).toBe(true);
    expect(parts.every((part) => part.text !== '## Big')).toBe(true);
  });

  it('AC-9: retains section metadata on every list part', () => {
    const parts = sections(chunk(list));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part).toMatchObject({ headingPath: 'List', anchor: 'list' });
  });

  it('AC-10: gives split list chunks contiguous indices including summary', () => {
    const chunks = chunk(list);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((part) => part.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it.each([
    ['line', 'x'.repeat(2001)],
    ['fence', lines(`${FENCE}ts`, 'x'.repeat(1991), FENCE)],
    ['summary', headings],
  ])('AC-11: caps every chunk for an oversized %s', (_label, text) => {
    capped(chunk(text));
  });

  it('AC-12: recognises a fence after a heading and balances each body part', () => {
    const parts = sections(chunk(lines('## Code', '', fenced)));
    capped(parts);
    expect(parts[0].text.split('\n')[0]).toBe('## Code');
    for (const part of parts) {
      const partLines = part.text.split('\n');
      const firstBody = partLines.findIndex((line) => body.includes(line));
      expect(firstBody).toBeGreaterThan(partLines.indexOf(`${FENCE}ts`));
      expect(partLines.indexOf(`${FENCE}ts`)).toBeGreaterThanOrEqual(0);
      expect(partLines[partLines.length - 1]).toBe(FENCE);
    }
  });

  it('AC-13: splits a long fenced body line with wrapper overhead counted', () => {
    const text = 'x'.repeat(4000);
    const parts = sections(chunk(lines(`${FENCE}ts`, text, FENCE)));
    capped(parts);
    for (const part of parts) {
      expect(part.text.startsWith(`${FENCE}ts\n`)).toBe(true);
      expect(part.text.endsWith(`\n${FENCE}`)).toBe(true);
    }
    expect(parts.map((part) => part.text.split('\n').slice(1, -1).join('\n')).join('')).toBe(text);
  });
});
