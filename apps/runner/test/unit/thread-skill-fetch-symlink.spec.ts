import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadSkillSource } from '@nathapp/fleet-protocol';
import type { GitResult } from '../../src/executor/git';
import { ensureSkills, type EnsureSkillsResult } from '../../src/thread/skill-fetch';

const root = join(import.meta.dir, `.skill-fetch-symlink-${crypto.randomUUID()}`);
const skillsRoot = join(root, 'skills-cache');
const repositoryRoot = join(root, 'origin-repository');
const sha = 'b'.repeat(40);
const cachedSkillDir = join(skillsRoot, 'public-skills', sha, 'skills', 'demo');

function skill(): ThreadSkillSource {
  return {
    sourceId: 'public-skills',
    owner: 'example-owner',
    repo: 'skills',
    sha,
    skills: [{ name: 'demo', dir: 'skills/demo', description: 'demo' }],
  } as unknown as ThreadSkillSource;
}

function copyingGit(): { run: (args: string[], options: { cwd: string }) => Promise<GitResult> } {
  return {
    async run(args, options) {
      if (args[0] === 'init') await mkdir(join(options.cwd, '.git'), { recursive: true });
      if (args.includes('fetch')) {
        await mkdir(options.cwd, { recursive: true });
        await cp(repositoryRoot, options.cwd, { recursive: true, verbatimSymlinks: true });
        await writeFile(join(options.cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

describe('ensureSkills with a symbolic link in the skill tree', () => {
  let result: EnsureSkillsResult;

  beforeAll(async () => {
    const skillDir = join(repositoryRoot, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# demo\n');
    await writeFile(join(skillDir, 'AGENTS.md'), '# agents\n');
    await symlink('AGENTS.md', join(skillDir, 'CLAUDE.md'));
    result = await ensureSkills({
      skills: [skill()],
      skillsRoot,
      git: copyingGit() as never,
      timeoutMs: 5000,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a symlink does not fail the whole skill fetch', () => {
    expect(result).toEqual({ ok: true });
  });

  test('the cached tree holds the regular files and no symbolic link', async () => {
    expect((await lstat(cachedSkillDir)).isDirectory()).toBe(true);
    const kept = await lstat(join(cachedSkillDir, 'AGENTS.md'));
    expect(kept.isFile()).toBe(true);
    const link = await lstat(join(cachedSkillDir, 'CLAUDE.md')).catch(() => undefined);
    expect(link).toBeUndefined();
  });
});
