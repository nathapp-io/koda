import type { ForgeTreeEntry } from '../git-broker/forge-tree';
import { isIndexablePath, selectIndexableEntries } from './knowledge-allowlist';
import { DEFAULT_KNOWLEDGE_PATTERNS } from './knowledge-patterns';

const blob = (path: string, size: number | null = 100): ForgeTreeEntry => ({ path, type: 'blob', sha: `sha-${path}`, size });

describe('isIndexablePath', () => {
  it.each([
    ['README.md', true],
    ['.nax/context.md', true],
    ['AGENTS.md', true],
    ['docs/a.md', true],
    ['docs/x/y/b.md', true],
    ['.nax/features/f1/spec.md', true],
    ['apps/api/README.md', false],
    ['CLAUDE.md', false],
    ['.nax/features/f1/prd.json', false],
    ['.nax/features/a/b/spec.md', false],
    ['docs/a.txt', false],
    ['src/a.ts', false],
  ])('%s -> %s', (path, expected) => {
    expect(isIndexablePath(path)).toBe(expected);
  });
});

describe('selectIndexableEntries', () => {
  it('keeps AGENTS.md when the entries hold no .nax/context.md', () => {
    const { kept } = selectIndexableEntries([blob('AGENTS.md'), blob('README.md')]);
    expect(kept.map((e) => e.path)).toEqual(['AGENTS.md', 'README.md']);
  });

  it('drops AGENTS.md when the entries hold .nax/context.md', () => {
    const { kept } = selectIndexableEntries([blob('AGENTS.md'), blob('.nax/context.md')]);
    expect(kept.map((e) => e.path)).toEqual(['.nax/context.md']);
  });

  it('skips an oversize entry and an unsafe path, and counts both', () => {
    const result = selectIndexableEntries([blob('docs/big.md', 300_000), blob("docs/it's.md"), blob('docs/ok.md')]);
    expect(result.kept.map((e) => e.path)).toEqual(['docs/ok.md']);
    expect(result.skipped).toBe(2);
    expect(result.capMessage).toBeNull();
  });

  it('ignores tree entries and non-matching blobs without counting them', () => {
    const tree: ForgeTreeEntry = { path: 'docs', type: 'tree', sha: 's', size: null };
    const result = selectIndexableEntries([tree, blob('src/a.ts'), blob('docs/a.md', null)]);
    expect(result.kept.map((e) => e.path)).toEqual(['docs/a.md']);
    expect(result.skipped).toBe(0);
  });

  it('keeps the first 2000 in input order and reports the cap', () => {
    const entries = Array.from({ length: 2001 }, (_, i) => blob(`docs/f${i}.md`));
    const result = selectIndexableEntries(entries);
    expect(result.kept).toHaveLength(2000);
    expect(result.kept[0].path).toBe('docs/f0.md');
    expect(result.kept[1999].path).toBe('docs/f1999.md');
    expect(result.skipped).toBe(1);
    expect(result.capMessage).toBe('2000-file cap reached');
  });
});

/**
 * US-002: the per-project patterns replace the fixed 3c-1 path rule when a project has saved a list. The size,
 * safe-path, 2000-file cap and AGENTS.md-beside-.nax/context.md rules apply either way.
 */
describe('selectIndexableEntries with patterns (US-002)', () => {
  const CORPUS = [
    'README.md', 'AGENTS.md', '.nax/context.md', 'docs/a.md', 'docs/x/b.md',
    '.nax/features/f/spec.md', '.nax/features/f/prd.json', 'apps/api/README.md', 'src/a.ts',
  ];

  it('AC-5: the default patterns keep exactly the paths the 3c-1 rule keeps', () => {
    const entries = CORPUS.map((path) => blob(path));

    const withPatterns = selectIndexableEntries(entries, DEFAULT_KNOWLEDGE_PATTERNS);
    const withoutPatterns = selectIndexableEntries(entries);

    expect(withPatterns.kept.map((e) => e.path)).toEqual(withoutPatterns.kept.map((e) => e.path));
    expect(withPatterns.kept.map((e) => e.path)).toEqual([
      'README.md', '.nax/context.md', 'docs/a.md', 'docs/x/b.md', '.nax/features/f/spec.md',
    ]);
    expect(withPatterns.skipped).toBe(withoutPatterns.skipped);
    expect(withPatterns.capMessage).toBeNull();
  });

  it('AC-6: a custom list replaces the default corpus', () => {
    const entries = [blob('handbook/a.md'), blob('docs/a.md'), blob('README.md')];

    const result = selectIndexableEntries(entries, ['handbook/*.md']);

    expect(result.kept.map((e) => e.path)).toEqual(['handbook/a.md']);
    expect(result.skipped).toBe(0);
  });

  it('AC-7: an oversize entry that matches a custom pattern is still skipped', () => {
    const result = selectIndexableEntries([blob('handbook/big.md', 300_000)], ['handbook/*.md']);

    expect(result.kept).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.capMessage).toBeNull();
  });

  it('keeps the AGENTS.md rule, the safe-path rule and the cap under a custom list', () => {
    const agents = selectIndexableEntries([blob('AGENTS.md'), blob('.nax/context.md')], ['**/*.md']);
    expect(agents.kept.map((e) => e.path)).toEqual(['.nax/context.md']);

    const unsafe = selectIndexableEntries([blob("handbook/it's.md"), blob('handbook/ok.md')], ['handbook/*.md']);
    expect(unsafe.kept.map((e) => e.path)).toEqual(['handbook/ok.md']);
    expect(unsafe.skipped).toBe(1);

    const capped = selectIndexableEntries(
      Array.from({ length: 2001 }, (_, i) => blob(`handbook/f${i}.md`)),
      ['handbook/*.md'],
    );
    expect(capped.kept).toHaveLength(2000);
    expect(capped.skipped).toBe(1);
    expect(capped.capMessage).toBe('2000-file cap reached');
  });

  it('never counts an entry a custom list does not match as a skip', () => {
    const result = selectIndexableEntries(
      [{ path: 'handbook', type: 'tree', sha: 's', size: null }, blob('src/a.ts'), blob('handbook/a.md', null)],
      ['handbook/*.md'],
    );

    expect(result.kept.map((e) => e.path)).toEqual(['handbook/a.md']);
    expect(result.skipped).toBe(0);
  });

  it('an empty pattern list selects nothing without falling back to the default corpus', () => {
    const result = selectIndexableEntries([blob('README.md'), blob('docs/a.md')], []);

    expect(result.kept).toEqual([]);
    expect(result.skipped).toBe(0);
  });
});
