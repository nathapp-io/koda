import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../git';
import { git as sh, isolateGit, makeOrigin } from '../../../test/helpers/git-fixture';
import { makeTempDirs } from '../../../test/helpers/tmp';
import { prepareConfigCheckout } from './checkout';
import { commitAndPushConfig, configBranchName, type ConfigPushInput } from './commit-push';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const identity = { name: 'koda-fleet[bot]', email: 'bot@koda.test' };

async function clone() {
  const base = await tmp.make('cfg-push');
  const origin = await makeOrigin(base, 'app', { files: { '.nax/rules/a.md': '# a\n' } });
  const repoDir = join(base, 'clone');
  await sh(base, 'clone', '-q', origin.url, repoDir);
  await prepareConfigCheckout(createGit(), repoDir, 'main');
  const input = (over: Partial<ConfigPushInput> = {}): ConfigPushInput => ({
    git: createGit(), repoDir, jobId: 'cj1', defaultBranch: 'main', title: 'Tighten rules', identity, credentialHelper: null,
    timeoutMs: () => 60_000, sleep: async () => undefined, ...over,
  });
  return { base, origin, repoDir, input };
}

describe('configBranchName', () => {
  test('is nax-config/<jobId> and refuses an unsafe job id', () => {
    expect(configBranchName('cj1')).toBe('nax-config/cj1');
    expect(() => configBranchName('../x')).toThrow();
  });
});

describe('commitAndPushConfig (spec §5 step 7, D487)', () => {
  test('commits every change as the job identity with the PR title and pushes the job branch', async () => {
    const w = await clone();
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# a edited\n');
    await writeFile(join(w.repoDir, 'CLAUDE.md'), 'generated\n');
    const result = await commitAndPushConfig(w.input());
    expect(result).toMatchObject({ kind: 'pushed', branch: 'nax-config/cj1', files: ['.nax/rules/a.md', 'CLAUDE.md'] });
    const sha = (result as { sha: string }).sha;
    expect(await sh(w.origin.dir, 'rev-parse', 'nax-config/cj1')).toBe(sha);
    expect(await sh(w.origin.dir, 'log', '-1', '--format=%s|%an|%ae', 'nax-config/cj1')).toBe('Tighten rules|koda-fleet[bot]|bot@koda.test');
    expect(await sh(w.origin.dir, 'rev-parse', 'nax-config/cj1~1')).toBe(await sh(w.origin.dir, 'rev-parse', 'main'));
  });
  test('nothing changed: no_changes, nothing pushed', async () => {
    const w = await clone();
    expect(await commitAndPushConfig(w.input())).toEqual({ kind: 'no_changes' });
    await expect(sh(w.origin.dir, 'rev-parse', '--verify', 'nax-config/cj1')).rejects.toThrow();
  });
  test('a requeued attempt replaces the previous attempt\'s branch (force push)', async () => {
    const w = await clone();
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# attempt 1\n');
    await commitAndPushConfig(w.input());
    await prepareConfigCheckout(createGit(), w.repoDir, 'main');
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# attempt 2\n');
    const second = await commitAndPushConfig(w.input());
    expect(second.kind).toBe('pushed');
    expect(await sh(w.origin.dir, 'show', 'nax-config/cj1:.nax/rules/a.md')).toBe('# attempt 2');
  });
  test('a push that keeps failing is push_failed after the back-off', async () => {
    const w = await clone();
    await writeFile(join(w.repoDir, '.nax/rules/a.md'), '# x\n');
    await sh(w.repoDir, 'remote', 'set-url', 'origin', `file://${join(w.base, 'gone.git')}`);
    const slept: number[] = [];
    const result = await commitAndPushConfig(w.input({ sleep: async (ms) => { slept.push(ms); } }));
    expect(result).toMatchObject({ kind: 'push_failed' });
    expect((result as { output: string }).output).toContain('git push failed');
    expect(slept).toEqual([2_000, 8_000]);
  });
});
