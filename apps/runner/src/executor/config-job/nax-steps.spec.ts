import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { regenerate } from './regenerate';
import { trackedRun } from './subprocess';
import { validateConfig } from './validate';
import type { NaxRun } from './regenerate';

const FAKE = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'fake-nax.ts');
const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const exists = (p: string) => stat(p).then(() => true, () => false);

async function repo(files: Record<string, string>) {
  const dir = await tmp.make('cfg-nax');
  const naxHome = join(dir, '.naxhome');
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const calls: string[][] = [];
  const nax: NaxRun = (args) => {
    calls.push([...args]);
    return trackedRun([process.execPath, FAKE, ...args], {
      cwd: dir, env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: naxHome }, deadlineMs: Date.now() + 30_000,
      nowMs: () => Date.now(), isStopped: () => false, onProcess: () => undefined,
    });
  };
  return { dir, nax, calls };
}

describe('regenerate (spec §5 step 4)', () => {
  test('root context only: one generate call', async () => {
    const r = await repo({ '.nax/context.md': '# ctx\n' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: ['generate'] });
    expect(await readFile(join(r.dir, 'CLAUDE.md'), 'utf8')).toContain('# ctx');
    expect(r.calls).toEqual([['generate', '-d', r.dir]]);
  });
  test('root and package contexts: both calls, package files written', async () => {
    const r = await repo({ '.nax/context.md': '# ctx\n', '.nax/mono/apps/api/context.md': '# api\n' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: ['generate', 'generate --all-packages'] });
    expect(await exists(join(r.dir, 'apps/api/CLAUDE.md'))).toBe(true);
  });
  test('package contexts without a root context: only --all-packages', async () => {
    const r = await repo({ '.nax/mono/apps/web/context.md': '# web\n' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: ['generate --all-packages'] });
  });
  test('no context at all: nothing runs', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await regenerate(r.nax, r.dir)).toEqual({ ok: true, ran: [] });
    expect(r.calls).toEqual([]);
  });
  test('a failing generate is a failure with the nax output, without the clone path', async () => {
    const r = await repo({ '.nax/context.md': 'FAKE_GENERATE_FAIL' });
    const result = await regenerate(r.nax, r.dir);
    expect(result).toMatchObject({ ok: false });
    expect((result as { output: string }).output).toContain('$ nax generate (exit 1)');
    expect((result as { output: string }).output).toContain('context.md is malformed');
    expect((result as { output: string }).output).not.toContain(r.dir);
  });
});

describe('validateConfig (spec §5 step 6)', () => {
  test('a clean repo with an edited profile and package config is valid', async () => {
    const r = await repo({ '.nax/config.json': '{}', '.nax/rules/a.md': '# a\n', '.nax/profiles/fast.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [
      { path: '.nax/profiles/fast.json', op: 'put', content: '{}', baseSha: null },
      { path: '.nax/mono/apps/api/config.json', op: 'put', content: '{"quality":{}}', baseSha: null },
    ])).toBeNull();
    expect(r.calls).toEqual([
      ['rules', 'lint', '-d', r.dir],
      ['config', '--json', '-d', r.dir],
      ['config', '--profile', 'fast', '--json', '-d', r.dir],
    ]);
  });
  test('a lint failure is invalid with the lint text, and stops there', async () => {
    const r = await repo({ '.nax/config.json': '{}', '.nax/rules/bad.md': 'FAKE_LINT_FAIL' });
    const result = await validateConfig(r.nax, r.dir, []);
    expect(result?.outcome).toBe('invalid');
    expect(result?.output).toContain('.nax/rules/bad.md: banned marker FAKE_LINT_FAIL');
    expect(r.calls).toHaveLength(1);
  });
  test('an unparsable root config is invalid with nax\'s error code', async () => {
    const r = await repo({ '.nax/config.json': '{ nope' });
    expect(await validateConfig(r.nax, r.dir, [])).toEqual({ outcome: 'invalid', output: 'nax config --json: CONFIG_PARSE_ERROR: fake-nax: CONFIG_PARSE_ERROR' });
  });
  test('a profile nax rejects is invalid', async () => {
    const r = await repo({ '.nax/config.json': '{}', '.nax/profiles/broken.json': JSON.stringify({ fakeError: 'PROFILE_INVALID' }) });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/profiles/broken.json', op: 'put', content: '{}', baseSha: null }]))
      .toEqual({ outcome: 'invalid', output: 'nax config --profile broken --json: PROFILE_INVALID: fake-nax: PROFILE_INVALID' });
  });
  test('a profile file name nax could not load is invalid without calling nax', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/profiles/-bad.json', op: 'put', content: '{}', baseSha: null }]))
      .toEqual({ outcome: 'invalid', output: 'invalid profile file name: .nax/profiles/-bad.json' });
  });
  test('a package config that is not a JSON object is invalid (D490)', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/mono/apps/api/config.json', op: 'put', content: '[1]', baseSha: null }]))
      .toEqual({ outcome: 'invalid', output: '.nax/mono/apps/api/config.json: not a JSON object' });
  });
  test('a deleted profile is not validated', async () => {
    const r = await repo({ '.nax/config.json': '{}' });
    expect(await validateConfig(r.nax, r.dir, [{ path: '.nax/profiles/old.json', op: 'delete', baseSha: 'a'.repeat(40) }])).toBeNull();
    expect(r.calls.map((c) => c[0])).toEqual(['rules', 'config']);
  });
});
