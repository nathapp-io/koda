/**
 * Fleet S5b US-002 (3c-2-D2) — the pure project Markdown corpus patterns: matching, validation and the
 * snapshot key that invalidates a pass. No Nest, no database, no forge.
 */
import {
  DEFAULT_KNOWLEDGE_PATTERNS, knowledgePatternsKey, matchesKnowledgePattern, parseKnowledgePatterns,
} from './knowledge-patterns';

describe('DEFAULT_KNOWLEDGE_PATTERNS', () => {
  it('is the 3c-1 corpus expressed as patterns', () => {
    expect([...DEFAULT_KNOWLEDGE_PATTERNS]).toEqual([
      'README.md', '.nax/context.md', 'AGENTS.md', 'docs/**/*.md', '.nax/features/*/spec.md',
    ]);
  });
});

describe('matchesKnowledgePattern', () => {
  it.each([
    ['docs/a.md', 'docs/**/*.md', true],
    ['docs/x/y/b.md', 'docs/**/*.md', true],
    ['.nax/features/f1/spec.md', '.nax/features/*/spec.md', true],
    ['handbook/intro.md', 'handbook/*.md', true],
    ['docs/a.txt', 'docs/**/*.md', false],
    ['.nax/features/a/b/spec.md', '.nax/features/*/spec.md', false],
    ['apps/README.md', 'README.md', false],
  ])('AC-1: matchesKnowledgePattern(%s, %s) is %s', (path, pattern, expected) => {
    expect(matchesKnowledgePattern(path, pattern)).toBe(expected);
  });

  it('anchors both ends, so a pattern is never a suffix or prefix match', () => {
    expect(matchesKnowledgePattern('apps/api/README.md', 'README.md')).toBe(false);
    expect(matchesKnowledgePattern('docs.md', 'docs/**/*.md')).toBe(false);
    expect(matchesKnowledgePattern('docs/a.md', 'docs/*.md')).toBe(true);
    expect(matchesKnowledgePattern('docs/x/a.md', 'docs/*.md')).toBe(false);
  });

  it('treats ** as zero or more whole segments', () => {
    expect(matchesKnowledgePattern('docs/a.md', 'docs/**/a.md')).toBe(true);
    expect(matchesKnowledgePattern('docs/x/y/a.md', 'docs/**/a.md')).toBe(true);
    expect(matchesKnowledgePattern('docs/x/y/a.md', '**/a.md')).toBe(true);
    expect(matchesKnowledgePattern('a.md', '**/a.md')).toBe(true);
    expect(matchesKnowledgePattern('docs/x/b.md', 'docs/**')).toBe(true);
    expect(matchesKnowledgePattern('docs', 'docs/**')).toBe(true);
  });

  it('lets * inside a segment match any run of characters but never a slash', () => {
    expect(matchesKnowledgePattern('handbook/intro.md', 'handbook/i*.md')).toBe(true);
    expect(matchesKnowledgePattern('handbook/note.md', 'handbook/n*e.md')).toBe(true);
    expect(matchesKnowledgePattern('handbook/.md', 'handbook/*.md')).toBe(true);
    expect(matchesKnowledgePattern('a/b.md', '*.md')).toBe(false);
    expect(matchesKnowledgePattern('handbook/sub/intro.md', 'handbook/*.md')).toBe(false);
  });

  it('matches every default pattern against the 3c-1 corpus paths and nothing else', () => {
    const matchesDefault = (path: string): boolean => DEFAULT_KNOWLEDGE_PATTERNS.some((p) => matchesKnowledgePattern(path, p));
    expect(matchesDefault('README.md')).toBe(true);
    expect(matchesDefault('.nax/context.md')).toBe(true);
    expect(matchesDefault('AGENTS.md')).toBe(true);
    expect(matchesDefault('docs/a.md')).toBe(true);
    expect(matchesDefault('.nax/features/f1/spec.md')).toBe(true);
    expect(matchesDefault('.nax/features/f1/prd.json')).toBe(false);
    expect(matchesDefault('src/a.ts')).toBe(false);
  });
});

describe('parseKnowledgePatterns', () => {
  it('AC-2: trims every entry and keeps the first of a duplicate', () => {
    expect(parseKnowledgePatterns(['docs/**/*.md', ' handbook/*.md ', 'docs/**/*.md'])).toEqual({
      ok: true, value: ['docs/**/*.md', 'handbook/*.md'],
    });
  });

  it('accepts a single pattern and the whole default list unchanged', () => {
    expect(parseKnowledgePatterns(['handbook/*.md'])).toEqual({ ok: true, value: ['handbook/*.md'] });
    expect(parseKnowledgePatterns([...DEFAULT_KNOWLEDGE_PATTERNS])).toEqual({ ok: true, value: [...DEFAULT_KNOWLEDGE_PATTERNS] });
  });

  it('accepts a pattern of exactly 200 characters and one of a single segment', () => {
    const long = `${'a'.repeat(197)}.md`;
    expect(long).toHaveLength(200);
    expect(parseKnowledgePatterns([long])).toEqual({ ok: true, value: [long] });
  });

  it.each([
    ['README.md', 'src/a.ts'],
    ['README.md', '/abs.md'],
    ['README.md', 'docs/../x.md'],
    ['README.md', 'docs/a**.md'],
    ['README.md', 'docs//a.md'],
  ])('AC-3: answers patterns[1] for %s', (first, second) => {
    expect(parseKnowledgePatterns([first, second])).toEqual({ ok: false, reason: 'patterns[1]' });
  });

  it.each([
    ['a non-Markdown extension', 'docs/a.txt'],
    ['a bare directory', 'docs/'],
    ['a dot segment', 'docs/./a.md'],
    ['a trailing **-like segment', 'docs/***.md'],
    ['a query character', 'docs/a?.md'],
    ['a character class', 'docs/[ab].md'],
    ['a negation', '!docs/a.md'],
    ['a backslash', 'docs\\a.md'],
    ['a space inside', 'docs/a b.md'],
    ['a 201-character pattern', `${'a'.repeat(198)}.md`],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ])('AC-3/AC-4: answers patterns[1] for %s', (_label, second) => {
    expect(parseKnowledgePatterns(['README.md', second])).toEqual({ ok: false, reason: 'patterns[1]' });
  });

  it.each([
    ['an empty list', []],
    ['51 patterns', Array.from({ length: 51 }, (_, i) => `docs/f${i}.md`)],
    ['a bare string', 'docs/*.md'],
    ['null', null],
    ['undefined', undefined],
  ])('AC-4: answers patterns for %s', (_label, input) => {
    expect(parseKnowledgePatterns(input)).toEqual({ ok: false, reason: 'patterns' });
  });

  it('fails a non-string entry with its own index', () => {
    expect(parseKnowledgePatterns(['README.md', 7])).toEqual({ ok: false, reason: 'patterns[1]' });
    expect(parseKnowledgePatterns(['README.md', ['handbook/*.md']])).toEqual({ ok: false, reason: 'patterns[1]' });
  });

  it('accepts exactly 50 patterns and fails 51 (the boundary)', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `docs/f${i}.md`);
    expect(parseKnowledgePatterns(fifty)).toEqual({ ok: true, value: fifty });
    expect(parseKnowledgePatterns([...fifty, 'docs/f50.md'])).toEqual({ ok: false, reason: 'patterns' });
  });

  it('names the first failing entry, not the last', () => {
    expect(parseKnowledgePatterns(['docs/*.md', 'src/a.ts', 'also/bad'])).toEqual({ ok: false, reason: 'patterns[1]' });
  });
});

describe('knowledgePatternsKey', () => {
  it('AC-10: answers default for no custom patterns', () => {
    expect(knowledgePatternsKey(null)).toBe('default');
  });

  it('joins the saved list with newlines, so only an identical list keeps the same key', () => {
    expect(knowledgePatternsKey(['handbook/*.md'])).toBe('handbook/*.md');
    expect(knowledgePatternsKey(['a.md', 'b.md'])).toBe('a.md\nb.md');
    expect(knowledgePatternsKey(['a.md', 'b.md'])).not.toBe(knowledgePatternsKey(['b.md', 'a.md']));
    expect(knowledgePatternsKey(['default.md'])).not.toBe(knowledgePatternsKey(null));
  });
});
