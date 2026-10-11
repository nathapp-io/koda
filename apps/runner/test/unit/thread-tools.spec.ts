import { describe, expect, test } from 'bun:test';
import type { Git, GitOptions, GitResult } from '../../src/executor/git';

const listFilesModule = await import('../../src/thread/tools/list-files').catch(() => undefined);
const searchRepoModule = await import('../../src/thread/tools/search-repo').catch(() => undefined);

type FileEntry = { path: string; content: string; binary?: boolean; tracked?: boolean; ignored?: boolean };
type ToolContext = {
  worktree: string;
  skillsRoot: string;
  skills: [];
  git: Git;
  searchTimeoutMs: number;
  nowMs: () => number;
};

function makeContext(files: FileEntry[], options: { nowMs?: () => number; searchTimeoutMs?: number } = {}): ToolContext {
  const git: Git = {
    async run(args: readonly string[], _options: GitOptions): Promise<GitResult> {
      if (args.includes('ls-files')) {
        let names = files.filter((file) => file.tracked !== false && file.ignored !== true).map((file) => file.path);
        const pathspec = args.find((arg) => arg.startsWith(':(glob)'));
        if (pathspec) {
          const expression = pathspec.slice(':(glob)'.length);
          if (expression.endsWith('/**')) {
            const dir = expression.slice(0, -3);
            names = names.filter((name) => name.startsWith(`${dir}/`));
          } else if (expression.includes('*.md')) {
            names = names.filter((name) => name.endsWith('.md'));
          }
        }
        return { code: 0, stdout: `${names.join('\0')}\0`, stderr: '' };
      }

      const patternIndex = args.indexOf('-e');
      const pattern = patternIndex >= 0 ? args[patternIndex + 1] ?? '' : '';
      const fixed = args.includes('-F');
      const globIndex = args.findIndex((arg) => arg.startsWith(':(glob)'));
      const glob = globIndex >= 0 ? args[globIndex].slice(':(glob)'.length) : undefined;
      const lineMatches = (line: string): boolean => (fixed ? line.includes(pattern) : new RegExp(pattern).test(line));
      const skipBinary = args.includes('-I');
      const withLineNumbers = args.includes('-n');
      const hitLine = (path: string, index: number, line: string): string =>
        (withLineNumbers ? `${path}:${index + 1}:${line}` : `${path}:${line}`);
      const matching = files.flatMap((file) => {
        if (file.tracked === false || file.ignored === true || (glob && glob.endsWith('*.md') && !file.path.endsWith('.md'))) return [];
        const fileLines = file.content.split('\n');
        if (file.binary) {
          // git grep -I skips binary files; without it git reports a match as a single summary line.
          if (skipBinary) return [];
          return fileLines.some(lineMatches) ? [`Binary file ${file.path} matches`] : [];
        }
        return fileLines.flatMap((line, index) => (lineMatches(line) ? [hitLine(file.path, index, line)] : []));
      });
      return matching.length
        ? { code: 0, stdout: `${matching.join('\n')}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    },
    async ok(_args: readonly string[], _options: GitOptions): Promise<string> {
      return '';
    },
  };
  return {
    worktree: '/worktree',
    skillsRoot: '/skills',
    skills: [],
    git,
    searchTimeoutMs: options.searchTimeoutMs ?? 1_000,
    nowMs: options.nowMs ?? (() => 0),
  };
}

const lines = (content: string | undefined): string[] => content?.split('\n') ?? [];

describe('tracked repository list and search tools (US-002)', () => {
  test('US-002 AC-1: lists tracked files without untracked or ignored entries', async () => {
    const ctx = makeContext([
      { path: 'a.ts', content: '' },
      { path: 'b.ts', content: '', tracked: false },
      { path: 'c.log', content: '', ignored: true },
    ]);
    const result = await listFilesModule?.listFilesTool(ctx).run({});
    expect(lines(result?.content)).toEqual(['a.ts']);
  });

  test('US-002 AC-2: limits tracked file listing to the requested directory', async () => {
    const ctx = makeContext([{ path: 'src/x.ts', content: '' }, { path: 'docs/y.md', content: '' }]);
    const result = await listFilesModule?.listFilesTool(ctx).run({ dir: 'src' });
    expect(lines(result?.content)).toEqual(['src/x.ts']);
  });

  test('US-002 AC-3: limits tracked file listing to the requested glob', async () => {
    const ctx = makeContext([{ path: 'src/x.ts', content: '' }, { path: 'docs/y.md', content: '' }]);
    const result = await listFilesModule?.listFilesTool(ctx).run({ glob: '**/*.md' });
    expect(lines(result?.content)).toEqual(['docs/y.md']);
  });

  test('US-002 AC-4: refuses a directory path that escapes the worktree', async () => {
    const result = await listFilesModule?.listFilesTool(makeContext([])).run({ dir: '../outside' });
    expect(result?.isError).toBe(true);
  });

  test('US-002 AC-5: refuses a glob containing parent traversal', async () => {
    const result = await listFilesModule?.listFilesTool(makeContext([])).run({ glob: 'src/../..' });
    expect(result?.isError).toBe(true);
  });

  test('US-002 AC-6: caps file listing at 2000 entries and reports the remainder', async () => {
    const files = Array.from({ length: 2_005 }, (_, index) => ({ path: `file-${index}.ts`, content: '' }));
    const result = await listFilesModule?.listFilesTool(makeContext(files)).run({});
    const output = lines(result?.content);
    expect([output.length, output.at(-1)]).toEqual([2_001, '[truncated: 5 more]']);
  });

  test('US-002 AC-7: reports a matching tracked line with its path and line number', async () => {
    const ctx = makeContext([{ path: 'src/a.ts', content: 'first\nsecond\nneedle' }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'needle' });
    expect(lines(result?.content)[0]?.startsWith('src/a.ts:3:')).toBe(true);
  });

  test('US-002 AC-8: treats a fixed search pattern literally', async () => {
    const ctx = makeContext([{ path: 'a.ts', content: 'a.b\naxb' }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'a.b', fixed: true });
    expect(lines(result?.content)).toHaveLength(1);
  });

  test('US-002 AC-9: reports truncation after the requested maximum number of hits', async () => {
    const ctx = makeContext([{ path: 'many.ts', content: Array.from({ length: 20 }, () => 'x').join('\n') }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'x', max: 5 });
    const output = lines(result?.content);
    expect([output.length, output.at(-1)]).toEqual([6, '[truncated]']);
  });

  test('US-002 AC-10: applies the default maximum of 200 search hits', async () => {
    const ctx = makeContext([{ path: 'many.ts', content: Array.from({ length: 300 }, () => 'x').join('\n') }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'x' });
    const output = lines(result?.content);
    expect([output.length, output.at(-1)]).toEqual([201, '[truncated]']);
  });

  test('US-002 AC-11: caps search output at 65536 bytes', async () => {
    const ctx = makeContext([{ path: 'many.ts', content: Array.from({ length: 150 }, () => `x${'a'.repeat(999)}`).join('\n') }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'x' });
    const byteLength = result?.content === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(result.content).byteLength;
    expect(byteLength).toBeLessThanOrEqual(65_536);
  });

  test('US-002 AC-12: marks a byte-capped search result as truncated', async () => {
    const ctx = makeContext([{ path: 'many.ts', content: Array.from({ length: 150 }, () => `x${'a'.repeat(999)}`).join('\n') }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'x' });
    expect(lines(result?.content).at(-1)).toBe('[truncated]');
  });

  test('US-002 AC-13: reports an ordinary no-match result without an error', async () => {
    const result = await searchRepoModule?.searchRepoTool(makeContext([{ path: 'a.ts', content: 'present' }])).run({ pattern: 'absent' });
    expect([result?.content, result?.isError]).toEqual(['no matches', undefined]);
  });

  test('US-002 AC-14: reports a git result that consumed the search timeout as timed out', async () => {
    let clock = 0;
    const ctx = makeContext([], { searchTimeoutMs: 50, nowMs: () => { const value = clock; clock += 50; return value; } });
    ctx.git.run = async () => ({ code: 137, stdout: '', stderr: 'killed' });
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'x' });
    expect([result?.isError, result?.content]).toEqual([true, 'search timed out']);
  });

  test('US-002 AC-15: excludes a tracked binary file from search results', async () => {
    const ctx = makeContext([{ path: 'image.bin', content: 'needle', binary: true }]);
    const result = await searchRepoModule?.searchRepoTool(ctx).run({ pattern: 'needle' });
    expect(result?.content).toBe('no matches');
  });
});
