import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmbedderTool, EmbedderToolResult } from '@nathapp/nax-agent';
import { createGit, type Git } from '../../src/executor/git';
import { buildProjectCodeTools, type ProjectCodePin, type ProjectCodeToolContext } from '../../src/thread/project-code/code-tools';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());

/** README.md and src/b.md are Markdown; big.txt is 200000 bytes over 2000 lines. */
const A_FILES = {
  'README.md': '# a\n',
  'big.txt': `${'x'.repeat(99)}\n`.repeat(2_000),
  'bin.dat': 'before\u0000after\n',
  'docs/readme.md': 'needle in docs\n',
  'empty.txt': '',
  'src/a.ts': 'line1\nline2\nneedle here\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n',
  'src/b.md': '# b\n',
  'src/日本語.txt': 'needle in unicode path\n',
};

interface Fixture {
  readonly a: ProjectCodePin;
  readonly b: ProjectCodePin;
  readonly c: ProjectCodePin;
  /** A repository whose commit holds a symlink (`link.txt` -> `a.txt`). */
  readonly d: ProjectCodePin;
}

let fixture: Fixture;

const realGit = createGit();

function context(pins: readonly ProjectCodePin[], extra: Partial<ProjectCodeToolContext> = {}): ProjectCodeToolContext {
  return { pins, unavailable: [], git: realGit, searchTimeoutMs: 30_000, nowMs: () => Date.now(), ...extra };
}

function tool(tools: readonly EmbedderTool[], name: string): EmbedderTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

function run(tools: readonly EmbedderTool[], name: string, input: unknown): Promise<EmbedderToolResult> {
  return tool(tools, name).run(input, { sessionId: 's1', toolCallId: 't1', signal: new AbortController().signal });
}

const sha7 = (pin: ProjectCodePin): string => pin.sha.slice(0, 7);

/** A bare origin whose single commit holds `a.txt` and a `link.txt` symlink to it. */
async function makeSymlinkOrigin(base: string, name: string): Promise<ProjectCodePin> {
  const dir = join(base, `${name}.git`);
  const work = join(base, `${name}-seed`);
  await mkdir(dir, { recursive: true });
  await mkdir(work, { recursive: true });
  await sh(dir, 'init', '-q', '--bare', '-b', 'main');
  await sh(work, 'init', '-q', '-b', 'main');
  await sh(work, 'remote', 'add', 'origin', dir);
  await writeFile(join(work, 'a.txt'), 'needle\n');
  await symlink('a.txt', join(work, 'link.txt'));
  await sh(work, 'add', '-A');
  await sh(work, 'commit', '-q', '-m', 'seed');
  await sh(work, 'push', '-q', 'origin', 'main');
  return { repo: `o/${name}`, sha: await sh(dir, 'rev-parse', 'main'), gitDir: dir };
}

beforeAll(async () => {
  const base = await tmp.make('project-code-tools');
  const a = await makeOrigin(base, 'a', { files: A_FILES });
  const b = await makeOrigin(base, 'b', { files: { 'b.txt': 'needle in b\n' } });
  const c = await makeOrigin(base, 'c', { files: { 'x.txt': 'x1\nx2\nx3\nx4\nx5\n' } });
  const pin = async (dir: string, repo: string): Promise<ProjectCodePin> => ({ repo, sha: await sh(dir, 'rev-parse', 'main'), gitDir: dir });
  fixture = {
    a: await pin(a.dir, 'o/a'),
    b: await pin(b.dir, 'o/b'),
    c: await pin(c.dir, 'o/c'),
    d: await makeSymlinkOrigin(base, 'd'),
  };
  // A commit after the pin: the pinned sha must never see it.
  await pushCommit(base, a.url, 'main', 'later.txt', 'later\n');
});

describe('project code tools (US-005)', () => {
  test('AC-1: the four tools come back named and ordered, each approved never', () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    expect(tools.map((candidate) => candidate.name)).toEqual(['list_repos', 'list_files', 'search_repo', 'read_file']);
    expect(tools.map((candidate) => candidate.approval)).toEqual(['never', 'never', 'never', 'never']);
  });

  test('AC-2: list_repos lists the pins by sha, then the unavailable repositories', async () => {
    const tools = buildProjectCodeTools(context(
      [{ repo: 'o/a', sha: 'abcdef1234deadbeef', gitDir: '/mirrors/a.git' }],
      { unavailable: [{ repo: 'o/g', reason: 'no installation' }] },
    ));
    expect(await run(tools, 'list_repos', {})).toEqual({ content: 'o/a @ abcdef1\no/g unavailable (no installation)' });

    const empty = buildProjectCodeTools(context([], { unavailable: [] }));
    expect(await run(empty, 'list_repos', {})).toEqual({ content: 'no repositories' });
  });

  test('AC-3: list_files lists every path of the pinned commit, never a later commit', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    const result = await run(tools, 'list_files', { repo: 'o/a' });
    expect(result.isError).toBeUndefined();
    expect(result.content.split('\n')).toEqual([
      'README.md', 'big.txt', 'bin.dat', 'docs/readme.md', 'empty.txt', 'src/a.ts', 'src/b.md', 'src/日本語.txt',
    ]);
    expect(result.content).not.toContain('later.txt');
  });

  test('AC-4: list_files filters by dir and by glob', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    expect((await run(tools, 'list_files', { repo: 'o/a', dir: 'src' })).content).toBe('src/a.ts\nsrc/b.md\nsrc/日本語.txt');
    expect((await run(tools, 'list_files', { repo: 'o/a', glob: '**/*.md' })).content).toBe('README.md\ndocs/readme.md\nsrc/b.md');
  });

  test('AC-5: list_files refuses an unknown repo and an escaping dir', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    expect(await run(tools, 'list_files', { repo: 'o/z' })).toEqual({ content: 'unknown repo', isError: true });
    const escaped = await run(tools, 'list_files', { repo: 'o/a', dir: '../x' });
    expect(escaped.isError).toBe(true);
    expect(escaped.content).toBe('invalid dir');
  });

  test('AC-6: search_repo emits owner/name:path:line:text, unquoted and without a sha', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    const result = await run(tools, 'search_repo', { repo: 'o/a', pattern: 'needle' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe([
      'o/a:docs/readme.md:1:needle in docs',
      'o/a:src/a.ts:3:needle here',
      'o/a:src/日本語.txt:1:needle in unicode path',
    ].join('\n'));
    expect(result.content).not.toContain(fixture.a.sha);
    expect(result.content).not.toContain('"');
  });

  test('AC-7: search_repo without a repo searches every pin, in pin order', async () => {
    const tools = buildProjectCodeTools(context([fixture.a, fixture.b]));
    const result = await run(tools, 'search_repo', { pattern: 'needle' });
    expect(result.content).toBe([
      'o/a:docs/readme.md:1:needle in docs',
      'o/a:src/a.ts:3:needle here',
      'o/a:src/日本語.txt:1:needle in unicode path',
      'o/b:b.txt:1:needle in b',
    ].join('\n'));
  });

  test('AC-8: a search with no hit answers no matches without an error', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    const result = await run(tools, 'search_repo', { pattern: 'zzz-no-such-text' });
    expect(result).toEqual({ content: 'no matches' });
  });

  test('AC-9: search_repo caps the hits at max and marks the cut', async () => {
    const tools = buildProjectCodeTools(context([fixture.c]));
    expect((await run(tools, 'search_repo', { pattern: 'x', max: 2 })).content)
      .toBe('o/c:x.txt:1:x1\no/c:x.txt:2:x2\n[truncated]');
  });

  test('AC-10: a grep past the search timeout answers search timed out', async () => {
    let elapsed = 0;
    const git: Git = {
      run: async (args) => {
        if (args.includes('grep')) elapsed = 5_000;
        return { code: 128, stdout: '', stderr: 'fatal: boom' };
      },
      ok: async () => '',
    };
    const tools = buildProjectCodeTools(context([fixture.a], { git, searchTimeoutMs: 1_000, nowMs: () => elapsed }));
    expect(await run(tools, 'search_repo', { repo: 'o/a', pattern: 'needle' }))
      .toEqual({ content: 'search timed out', isError: true });
  });

  test('AC-11: read_file returns the header and exactly the requested lines', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    const result = await run(tools, 'read_file', { repo: 'o/a', path: 'src/a.ts', startLine: 2, endLine: 3 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`o/a:src/a.ts@${sha7(fixture.a)} lines 2-3 of 10\nline2\nneedle here`);
  });

  test('AC-12: read_file answers not found, not a file and binary file', async () => {
    const tools = buildProjectCodeTools(context([fixture.a, fixture.d]));
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['o/a', 'src/nope.ts', 'not found'],
      ['o/a', 'src', 'not a file'],
      ['o/a', 'bin.dat', 'binary file'],
      ['o/d', 'link.txt', 'not a file'],
    ];
    for (const [repo, path, expected] of cases) {
      expect({ repo, path, ...(await run(tools, 'read_file', { repo, path })) }).toEqual({ repo, path, content: expected, isError: true });
    }
  });

  test('AC-13: read_file refuses invalid lines and reads an empty file head on', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ startLine: 0 }, 'invalid lines'],
      [{ startLine: 1.5 }, 'invalid lines'],
      [{ startLine: 5, endLine: 4 }, 'invalid lines'],
      [{ startLine: 50 }, 'invalid lines'],
      [{ path: 'empty.txt', startLine: 2 }, 'invalid lines'],
    ];
    for (const [lines, expected] of cases) {
      const input = { repo: 'o/a', path: 'src/a.ts', ...(lines as Record<string, number>) };
      expect({ ...input, ...(await run(tools, 'read_file', input)) }).toEqual({ ...input, content: expected, isError: true });
    }
    expect((await run(tools, 'read_file', { repo: 'o/a', path: 'empty.txt' })).content)
      .toBe(`o/a:empty.txt@${sha7(fixture.a)} lines 0-0 of 0`);
  });

  test('AC-14: read_file caps a huge file at 65536 bytes and marks the cut', async () => {
    const tools = buildProjectCodeTools(context([fixture.a]));
    const result = await run(tools, 'read_file', { repo: 'o/a', path: 'big.txt' });
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(result.content.endsWith('[truncated]')).toBe(true);
    expect(result.content.startsWith(`o/a:big.txt@${sha7(fixture.a)} lines 1-2000 of 2000\n`)).toBe(true);
  });

  test('every git call runs in the pin with an isolated config and the search timeout', async () => {
    const seen: Array<{ cwd: string; env: Readonly<Record<string, string>> | undefined; timeoutMs: number | undefined }> = [];
    const git: Git = {
      run: async (args, options) => {
        seen.push({ cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
        return { code: 0, stdout: args.includes('ls-tree') ? 'a.txt\0' : 'needle\n', stderr: '' };
      },
      ok: async () => '',
    };
    const pin = { repo: 'o/a', sha: 'abcdef1'.padEnd(40, '0'), gitDir: '/mirrors/a.git' };
    const tools = buildProjectCodeTools(context([pin], { git, searchTimeoutMs: 4_321 }));
    await run(tools, 'list_files', { repo: 'o/a' });
    await run(tools, 'search_repo', { repo: 'o/a', pattern: 'needle' });
    expect(seen).toEqual([
      { cwd: '/mirrors/a.git', env: { GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: 4_321 },
      { cwd: '/mirrors/a.git', env: { GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: 4_321 },
    ]);
  });
});
