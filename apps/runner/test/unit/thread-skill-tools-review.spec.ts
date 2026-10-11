import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadSkillSource } from '@nathapp/fleet-protocol';
import { PathError } from '../../src/paths/safe-segment';
import { loadSkillTool } from '../../src/thread/tools/load-skill';
import { readSkillFileTool } from '../../src/thread/tools/read-skill-file';
import { readSkill } from '../../src/thread/tools/skill-files';
import type { ThreadToolContext } from '../../src/thread/tools/types';
import type { Git } from '../../src/executor/git';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const unusedGit: Git = {
  async run() {
    return { code: 0, stdout: '', stderr: '' };
  },
  async ok() {
    return '';
  },
};

async function makeContext(): Promise<ThreadToolContext> {
  const root = await mkdtemp(join(tmpdir(), 'koda-thread-skills-review-'));
  temporaryDirectories.push(root);
  const skillsRoot = join(root, 'skills');
  const sha = 'b'.repeat(40);
  const skillDir = join(skillsRoot, 'source-b', sha, 'skills', 'spec-writing');
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# Spec writing\n');
  await writeFile(join(skillDir, 'references', 'guide.md'), '# Guide\n');
  const skills: ThreadSkillSource[] = [{
    sourceId: 'source-b',
    owner: 'owner',
    repo: 'repo',
    sha,
    skills: [{ name: 'spec-writing', dir: 'skills/spec-writing', description: 'spec skill' }],
  }];
  return { worktree: root, skillsRoot, skills, git: unusedGit, searchTimeoutMs: 1_000, nowMs: () => 0 };
}

describe('skill tools review fixes (US-004)', () => {
  test('an unknown skill name is capped and stripped of control characters before it is echoed', async () => {
    const ctx = await makeContext();
    const hostile = `\u001b[31m${'n'.repeat(5_000)}\u0007`;
    const result = await loadSkillTool(ctx).run({ name: hostile });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('\u001b');
    expect(result.content).not.toContain('\u0007');
    expect(result.content?.length ?? 0).toBeLessThanOrEqual(800 + 'unknown skill ; available: spec-writing'.length);
    expect(result.content).toContain('available: spec-writing');
  });

  test('an unknown skill name that holds a secret-looking token is redacted', async () => {
    const ctx = await makeContext();
    const result = await loadSkillTool(ctx).run({ name: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.content).toContain('[redacted]');
  });

  test('readSkill refuses an invalid relPath itself, so no caller can skip the first jail layer', async () => {
    const ctx = await makeContext();
    await expect(readSkill(ctx, 'spec-writing', '../other/SKILL.md')).rejects.toBeInstanceOf(PathError);
    await expect(readSkill(ctx, 'spec-writing', '/etc/passwd')).rejects.toBeInstanceOf(PathError);
  });

  test('read_skill_file still returns a nested file after the handle-based read', async () => {
    const ctx = await makeContext();
    const result = await readSkillFileTool(ctx).run({ name: 'spec-writing', relPath: 'references/guide.md' });
    expect(result).toEqual({ content: '# Guide\n' });
  });
});
