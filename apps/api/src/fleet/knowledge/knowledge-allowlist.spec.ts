import type { ForgeTreeEntry } from '../git-broker/forge-tree';
import { isIndexablePath, selectIndexableEntries } from './knowledge-allowlist';

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
