import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../git';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../../../test/helpers/git-fixture';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { applyEdits } from './apply-edits';
import { prepareConfigCheckout } from './checkout';
import { changedFiles } from './drift';
import { currentBlob, findConflicts } from './staleness';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const exists = (p: string) => stat(p).then(() => true, () => false);

async function clone() {
  const base = await tmp.make('cfg-git');
  const origin = await makeOrigin(base, 'app', { files: { 'README.md': 'x\n', '.nax/context.md': '# ctx\n', '.nax/rules/a.md': '# a\n', '.nax/config.json': '{}\n' } });
  const repoDir = join(base, 'clone');
  await sh(base, 'clone', '-q', origin.url, repoDir);
  return { base, origin, repoDir, git: createGit() };
}

describe('prepareConfigCheckout', () => {
  test('detaches at origin/<defaultBranch> after an upstream push, discarding local edits', async () => {
    const w = await clone();
    const upstream = await pushCommit(w.base, w.origin.url, 'main', '.nax/rules/a.md', '# a v2\n');
    await sh(w.repoDir, 'fetch', '-q', 'origin');
    await writeFile(join(w.repoDir, '.nax/context.md'), 'dirty');
    expect(await prepareConfigCheckout(w.git, w.repoDir, 'main')).toEqual({ ok: true, sha: upstream });
    expect(await sh(w.repoDir, 'rev-parse', 'HEAD')).toBe(upstream);
    expect(await readFile(join(w.repoDir, '.nax/context.md'), 'utf8')).toBe('# ctx\n');
  });
  test('a default branch missing on origin is a fixed reason', async () => {
    const w = await clone();
    expect(await prepareConfigCheckout(w.git, w.repoDir, 'trunk')).toEqual({ ok: false, reason: 'checkout: default branch not found' });
  });
});

describe('staleness (S3-5)', () => {
  test('a file unchanged upstream does not conflict; a changed one does; a new file must be absent', async () => {
    const w = await clone();
    const blobA = await currentBlob(w.git, w.repoDir, '.nax/rules/a.md');
    const blobCtx = await currentBlob(w.git, w.repoDir, '.nax/context.md');
    expect(blobA).toMatch(/^[0-9a-f]{40}$/);
    expect(await currentBlob(w.git, w.repoDir, '.nax/rules/missing.md')).toBeNull();
    await pushCommit(w.base, w.origin.url, 'main', '.nax/rules/a.md', '# a changed upstream\n');
    await pushCommit(w.base, w.origin.url, 'main', '.nax/rules/new.md', '# created upstream\n');
    await sh(w.repoDir, 'fetch', '-q', 'origin');
    await prepareConfigCheckout(w.git, w.repoDir, 'main');
    const conflicts = await findConflicts(w.git, w.repoDir, [
      { path: '.nax/rules/a.md', op: 'put', content: 'mine', baseSha: blobA },
      { path: '.nax/context.md', op: 'put', content: 'mine', baseSha: blobCtx },
      { path: '.nax/rules/new.md', op: 'put', content: 'mine', baseSha: null },
      { path: '.nax/rules/fresh.md', op: 'put', content: 'mine', baseSha: null },
    ]);
    expect(conflicts).toEqual(['.nax/rules/a.md', '.nax/rules/new.md']);
  });
  test('a delete of a file already deleted upstream conflicts', async () => {
    const w = await clone();
    const blobA = await currentBlob(w.git, w.repoDir, '.nax/rules/a.md');
    const work = join(w.base, 'rm');
    await sh(w.base, 'clone', '-q', w.origin.url, work);
    await sh(work, 'rm', '-q', '.nax/rules/a.md');
    await sh(work, 'commit', '-q', '-m', 'rm');
    await sh(work, 'push', '-q', 'origin', 'main');
    await sh(w.repoDir, 'fetch', '-q', 'origin');
    await prepareConfigCheckout(w.git, w.repoDir, 'main');
    expect(await findConflicts(w.git, w.repoDir, [{ path: '.nax/rules/a.md', op: 'delete', baseSha: blobA }])).toEqual(['.nax/rules/a.md']);
  });
});

describe('applyEdits', () => {
  test('writes, creates nested directories and deletes', async () => {
    const w = await clone();
    expect(await applyEdits(w.repoDir, [
      { path: '.nax/rules/a.md', op: 'put', content: '# a edited\n', baseSha: null },
      { path: '.nax/mono/apps/api/context.md', op: 'put', content: '# api\n', baseSha: null },
      { path: '.nax/context.md', op: 'delete', baseSha: null },
    ])).toEqual({ ok: true });
    expect(await readFile(join(w.repoDir, '.nax/rules/a.md'), 'utf8')).toBe('# a edited\n');
    expect(await readFile(join(w.repoDir, '.nax/mono/apps/api/context.md'), 'utf8')).toBe('# api\n');
    expect(await exists(join(w.repoDir, '.nax/context.md'))).toBe(false);
  });
  test('refuses a path outside the allowlist and an .env profile, writing nothing for them', async () => {
    const w = await clone();
    expect(await applyEdits(w.repoDir, [{ path: 'src/x.ts', op: 'put', content: 'x', baseSha: null }])).toEqual({ ok: false, output: 'path not allowed: src/x.ts' });
    expect(await applyEdits(w.repoDir, [{ path: '.nax/profiles/prod.env', op: 'put', content: 'KEY=1', baseSha: null }])).toEqual({ ok: false, output: 'path not allowed: .nax/profiles/prod.env' });
    expect(await exists(join(w.repoDir, '.nax/profiles/prod.env'))).toBe(false);
  });
  test('refuses a symlinked directory or file on the path (no write escapes the clone)', async () => {
    const w = await clone();
    const outside = join(w.base, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(w.repoDir, '.nax/mono'));
    expect(await applyEdits(w.repoDir, [{ path: '.nax/mono/apps/api/context.md', op: 'put', content: 'pwn', baseSha: null }]))
      .toEqual({ ok: false, output: 'refused symlink: .nax/mono' });
    expect(await exists(join(outside, 'apps/api/context.md'))).toBe(false);
    await symlink(join(outside, 'target.md'), join(w.repoDir, '.nax/rules/link.md'));
    expect(await applyEdits(w.repoDir, [{ path: '.nax/rules/link.md', op: 'put', content: 'pwn', baseSha: null }]))
      .toEqual({ ok: false, output: 'refused symlink: .nax/rules/link.md' });
    expect(await exists(join(outside, 'target.md'))).toBe(false);
  });
  test('writes UTF-8 content with non-ASCII characters byte for byte', async () => {
    const w = await clone();
    const content = '# 规则 ✓\n- café\r\n';
    expect(await applyEdits(w.repoDir, [{ path: '.nax/rules/zh.md', op: 'put', content, baseSha: null }])).toEqual({ ok: true });
    expect(await readFile(join(w.repoDir, '.nax/rules/zh.md'))).toEqual(Buffer.from(content, 'utf8'));
  });
});

describe('changedFiles (D469)', () => {
  test('lists modified, deleted and untracked files, sorted, renames by their new name', async () => {
    const w = await clone();
    expect(await changedFiles(w.git, w.repoDir)).toEqual([]);
    await writeFile(join(w.repoDir, 'CLAUDE.md'), 'gen');
    await mkdir(join(w.repoDir, 'apps/api'), { recursive: true });
    await writeFile(join(w.repoDir, 'apps/api/CLAUDE.md'), 'gen');
    await writeFile(join(w.repoDir, '.nax/context.md'), 'changed');
    await sh(w.repoDir, 'mv', 'README.md', 'README2.md');
    expect(await changedFiles(w.git, w.repoDir)).toEqual(['.nax/context.md', 'CLAUDE.md', 'README2.md', 'apps/api/CLAUDE.md']);
  });
});
