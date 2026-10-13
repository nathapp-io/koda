import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../../src/executor/git';
import { buildThreadTools } from '../../src/thread/tools';
import { listFilesTool } from '../../src/thread/tools/list-files';
import { searchRepoTool } from '../../src/thread/tools/search-repo';
import { writeDocTool } from '../../src/thread/tools/write-doc';
import type { ThreadToolContext } from '../../src/thread/tools/types';
import { git, isolateGit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());

/** `git status --porcelain` lines without trimming, so a leading space (the ` M` form) is kept. */
async function porcelainStatus(worktree: string): Promise<string[]> {
  const proc = Bun.spawn(['git', 'status', '--porcelain'], { cwd: worktree, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git status failed (${code})`);
  return out.split('\n').filter((line) => line.length > 0);
}

/** A real git worktree with `docs/guide.md` committed, so `git status` has a clean baseline. */
async function makeWorktree(): Promise<string> {
  const worktree = await tmp.make('write-doc');
  await git(worktree, 'init', '-q', '-b', 'main');
  await mkdir(join(worktree, 'docs'), { recursive: true });
  await writeFile(join(worktree, 'docs', 'guide.md'), 'old');
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', 'seed');
  return worktree;
}

function contextFor(worktree: string, overrides: Partial<ThreadToolContext> = {}): ThreadToolContext {
  return {
    worktree,
    skillsRoot: join(worktree, '..', 'skills'),
    skills: [],
    git: createGit(),
    searchTimeoutMs: 10_000,
    nowMs: () => Date.now(),
    feature: 'divide',
    ...overrides,
  };
}

describe('write_doc (US-003)', () => {
  test('US-003 AC-1: writes the content to an allowlisted feature spec in the worktree', async () => {
    const worktree = await makeWorktree();
    await writeDocTool(contextFor(worktree)).run({ path: '.nax/features/divide/spec.md', content: '# Divide' });
    expect(await readFile(join(worktree, '.nax/features/divide/spec.md'), 'utf8')).toBe('# Divide');
  });

  test('US-003 AC-2: returns the wrote message with the byte count and no error', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run({ path: '.nax/features/divide/spec.md', content: '# Divide' });
    expect(result).toEqual({ content: 'wrote .nax/features/divide/spec.md (8 bytes)' });
    expect(result.isError).toBeUndefined();
  });

  test('US-003 AC-3: refuses a path outside the allowlist and writes nothing', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'src/index.md', content: 'x' });
    expect(result).toEqual({ content: 'path not allowed: src/index.md', isError: true });
    await expect(readFile(join(worktree, 'src', 'index.md'), 'utf8')).rejects.toThrow();
  });

  test('US-003 AC-4: refuses content that is not a string', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'docs/a.md', content: 7 });
    expect(result).toEqual({ content: 'content must be a string', isError: true });
  });

  test('US-003 AC-5: refuses content over 524288 UTF-8 bytes and writes nothing', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'docs/a.md', content: 'a'.repeat(524_289) });
    expect(result).toEqual({ content: 'content too large', isError: true });
    await expect(readFile(join(worktree, 'docs', 'a.md'), 'utf8')).rejects.toThrow();
  });

  test('US-003 AC-5: counts the limit in UTF-8 bytes, so multi-byte text over 524288 bytes is refused', async () => {
    const worktree = await makeWorktree();
    // 300 000 characters of two bytes each is 600 000 bytes, over the limit though under 524 289 characters.
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'docs/a.md', content: 'é'.repeat(300_000) });
    expect(result).toEqual({ content: 'content too large', isError: true });
  });

  test('US-003 AC-5: accepts content of exactly 524288 bytes', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'docs/a.md', content: 'a'.repeat(524_288) });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('wrote docs/a.md (524288 bytes)');
  });

  test('US-003 AC-6: refuses a parent directory that is a symlink to a directory outside the worktree', async () => {
    const worktree = await makeWorktree();
    const outside = await tmp.make('outside-dir');
    await git(worktree, 'rm', '-rq', 'docs');
    await symlink(outside, join(worktree, 'docs'));
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'docs/a.md', content: 'x' });
    expect(result).toEqual({ content: 'refused symlink: docs', isError: true });
    await expect(readFile(join(outside, 'a.md'), 'utf8')).rejects.toThrow();
  });

  test('US-003 AC-7: refuses a target that is an existing symlink and leaves the link target alone', async () => {
    const worktree = await makeWorktree();
    const outside = await tmp.make('outside-file');
    const victim = join(outside, 'victim.md');
    await writeFile(victim, 'keep');
    await symlink(victim, join(worktree, 'docs', 'a.md'));
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'docs/a.md', content: 'x' });
    expect(result).toEqual({ content: 'refused symlink: docs/a.md', isError: true });
    expect(await readFile(victim, 'utf8')).toBe('keep');
  });

  test('US-003 AC-8: leaves the write uncommitted, so git status shows only the modified file', async () => {
    const worktree = await makeWorktree();
    await writeDocTool(contextFor(worktree)).run({ path: 'docs/guide.md', content: 'new' });
    expect(await porcelainStatus(worktree)).toEqual([' M docs/guide.md']);
  });

  test('US-003 AC-9: calls onDocWritten once with the path and the byte count', async () => {
    const worktree = await makeWorktree();
    const calls: Array<[string, number]> = [];
    await writeDocTool(contextFor(worktree, { onDocWritten: (path, bytes) => calls.push([path, bytes]) }))
      .run({ path: 'docs/a.md', content: 'hello' });
    expect(calls).toEqual([['docs/a.md', 5]]);
  });

  test('US-003 AC-10: does not call onDocWritten for a refused path', async () => {
    const worktree = await makeWorktree();
    const calls: Array<[string, number]> = [];
    await writeDocTool(contextFor(worktree, { onDocWritten: (path, bytes) => calls.push([path, bytes]) }))
      .run({ path: 'src/index.md', content: 'x' });
    expect(calls).toEqual([]);
  });

  test('US-003: a directory at the target is an isError result with no onDocWritten call', async () => {
    const worktree = await makeWorktree();
    await mkdir(join(worktree, 'docs', 'a.md'));
    const calls: string[] = [];
    const result = await writeDocTool(contextFor(worktree, { onDocWritten: (path) => calls.push(path) }))
      .run({ path: 'docs/a.md', content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  test('US-003: a parent segment that is a regular file is an isError result with no onDocWritten call', async () => {
    const worktree = await makeWorktree();
    const calls: string[] = [];
    // docs is a regular file in the seed commit, so docs/guide.md cannot have a directory parent.
    const result = await writeDocTool(contextFor(worktree, { onDocWritten: (path) => calls.push(path) }))
      .run({ path: 'docs/guide.md/inner.md', content: 'x' });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test('US-003: a refused path echoed back is capped at 512 characters', async () => {
    const worktree = await makeWorktree();
    const longPath = `src/${'p'.repeat(5_000)}.md`;
    const result = await writeDocTool(contextFor(worktree)).run({ path: longPath, content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(`path not allowed: ${longPath.slice(0, 512)}`);
  });

  test('US-003: the path check runs before the content check', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run({ path: 'src/index.md', content: 7 });
    expect(result).toEqual({ content: 'path not allowed: src/index.md', isError: true });
  });

  test('US-003: an invalid input object is refused, not thrown', async () => {
    const worktree = await makeWorktree();
    const result = await writeDocTool(contextFor(worktree)).run(undefined);
    expect(result).toEqual({ content: 'path not allowed: undefined', isError: true });
  });

  test('US-003: a context without a feature allows only docs/** paths', async () => {
    const worktree = await makeWorktree();
    const withoutFeature = contextFor(worktree, { feature: undefined });
    expect((await writeDocTool(withoutFeature).run({ path: '.nax/features/divide/spec.md', content: 'x' })).isError).toBe(true);
    expect((await writeDocTool(withoutFeature).run({ path: 'docs/a.md', content: 'x' })).isError).toBeUndefined();
  });

  test('US-003: the tool is named write_doc, has approval never and a closed input schema', () => {
    const tool = writeDocTool(contextFor('/unused'));
    expect(tool.name).toBe('write_doc');
    expect(tool.approval).toBe('never');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['path', 'content'],
      additionalProperties: false,
    });
  });
});

describe('buildThreadTools with write_doc (US-003)', () => {
  test('US-003 AC-11: returns the five tools in order, write_doc last', () => {
    const tools = buildThreadTools(contextFor('/unused'));
    expect(tools.map((tool) => tool.name)).toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file', 'write_doc']);
  });
});

describe('allowlisted untracked files in list_files and search_repo (US-003)', () => {
  test('US-003 AC-12: list_files lists an untracked allowlisted doc', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'a.md'), 'draft');
    const result = await listFilesTool(contextFor(worktree)).run({});
    expect(result.content.split('\n')).toContain('docs/a.md');
  });

  test('US-003 AC-13: list_files does not list an untracked file outside the allowlist', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'notes.md'), 'draft');
    const result = await listFilesTool(contextFor(worktree)).run({});
    expect(result.content.split('\n')).not.toContain('notes.md');
  });

  test('US-003 AC-14: search_repo reports a hit in an untracked allowlisted doc', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'a.md'), 'needle');
    const result = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle' });
    expect(result.content.split('\n').some((line) => line.startsWith('docs/a.md:1:'))).toBe(true);
  });

  test('US-003 AC-15: search_repo does not report a hit in an untracked file outside the allowlist', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'notes.md'), 'needle');
    const result = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle' });
    expect(result.content.split('\n').some((line) => line.startsWith('notes.md'))).toBe(false);
    expect(result.content).toBe('no matches');
  });

  test('US-003: list_files never lists an ignored allowlisted doc', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, '.gitignore'), 'docs/ignored.md\n');
    await git(worktree, 'add', '.gitignore');
    await git(worktree, 'commit', '-q', '-m', 'ignore');
    await writeFile(join(worktree, 'docs', 'ignored.md'), 'secret');
    const result = await listFilesTool(contextFor(worktree)).run({});
    expect(result.content.split('\n')).not.toContain('docs/ignored.md');
  });

  test('US-003: search_repo never searches an ignored allowlisted doc', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, '.gitignore'), 'docs/ignored.md\n');
    await git(worktree, 'add', '.gitignore');
    await git(worktree, 'commit', '-q', '-m', 'ignore');
    await writeFile(join(worktree, 'docs', 'ignored.md'), 'needle');
    const result = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle' });
    expect(result.content).toBe('no matches');
  });

  test('US-003: list_files lists the tracked files first, then the untracked allowlisted docs', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'b.md'), 'draft');
    const result = await listFilesTool(contextFor(worktree)).run({});
    expect(result.content.split('\n')).toEqual(['docs/guide.md', 'docs/b.md']);
  });

  test('US-003: list_files honours the glob for untracked docs too', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'b.md'), 'draft');
    await writeFile(join(worktree, 'docs', 'c.txt'), 'draft');
    const result = await listFilesTool(contextFor(worktree)).run({ glob: '**/*.md' });
    expect(result.content.split('\n')).toEqual(['docs/guide.md', 'docs/b.md']);
  });

  test('US-003: list_files de-duplicates untracked docs and keeps first-seen order', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'b.md'), 'draft');
    await writeFile(join(worktree, 'docs', 'c.md'), 'draft');
    const lines = (await listFilesTool(contextFor(worktree)).run({})).content.split('\n');
    expect(lines).toEqual(['docs/guide.md', 'docs/b.md', 'docs/c.md']);
  });

  test('US-003: search_repo lists tracked hits before untracked hits', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'guide.md'), 'needle tracked\n');
    await git(worktree, 'commit', '-qam', 'tracked needle');
    await writeFile(join(worktree, 'docs', 'a.md'), 'needle untracked');
    const result = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle' });
    expect(result.content.split('\n')).toEqual(['docs/guide.md:1:needle tracked', 'docs/a.md:1:needle untracked']);
  });

  test('US-003: search_repo caps the combined tracked and untracked hits at max', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'guide.md'), 'needle tracked\n');
    await git(worktree, 'commit', '-qam', 'tracked needle');
    await writeFile(join(worktree, 'docs', 'a.md'), 'needle untracked');
    const result = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle', max: 1 });
    expect(result.content.split('\n')).toEqual(['docs/guide.md:1:needle tracked', '[truncated]']);
  });

  test('US-003: search_repo honours the glob for untracked docs too', async () => {
    const worktree = await makeWorktree();
    await writeFile(join(worktree, 'docs', 'a.md'), 'needle');
    const outOfGlob = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle', glob: 'src/**' });
    expect(outOfGlob.content).toBe('no matches');
    const inGlob = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle', glob: 'docs/**' });
    expect(inGlob.content).toBe('docs/a.md:1:needle');
  });

  test('US-003: an untracked allowlisted symlink is neither listed nor searched, so no outside file is read', async () => {
    const worktree = await makeWorktree();
    const outside = await tmp.make('outside-link');
    const secret = join(outside, 'secret.md');
    await writeFile(secret, 'needle');
    await symlink(secret, join(worktree, 'docs', 'link.md'));
    const listed = await listFilesTool(contextFor(worktree)).run({});
    expect(listed.content.split('\n')).not.toContain('docs/link.md');
    const found = await searchRepoTool(contextFor(worktree)).run({ pattern: 'needle' });
    expect(found.content).toBe('no matches');
  });

  test('US-003: the feature in the context decides which .nax/features path is allowlisted', async () => {
    const worktree = await makeWorktree();
    await mkdir(join(worktree, '.nax', 'features', 'divide'), { recursive: true });
    await writeFile(join(worktree, '.nax', 'features', 'divide', 'spec.md'), 'needle');
    const listed = await listFilesTool(contextFor(worktree, { feature: 'other' })).run({});
    expect(listed.content.split('\n')).not.toContain('.nax/features/divide/spec.md');
    const listedForFeature = await listFilesTool(contextFor(worktree)).run({});
    expect(listedForFeature.content.split('\n')).toContain('.nax/features/divide/spec.md');
  });
});
