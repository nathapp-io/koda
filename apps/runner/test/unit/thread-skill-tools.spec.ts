import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Git, GitOptions, GitResult } from '../../src/executor/git';
import type { ThreadSkillSource } from '@nathapp/fleet-protocol';
import type { ThreadToolContext } from '../../src/thread/tools/types';

const loadSkillModule = await import('../../src/thread/tools/load-skill').catch(() => undefined);
const readSkillFileModule = await import('../../src/thread/tools/read-skill-file').catch(() => undefined);
const toolsIndexModule = await import('../../src/thread/tools').catch(() => undefined);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function makeGit(): Git {
  return {
    async run(_args: readonly string[], _options: GitOptions): Promise<GitResult> {
      return { code: 0, stdout: '', stderr: '' };
    },
    async ok(_args: readonly string[], _options: GitOptions): Promise<string> {
      return '';
    },
  };
}

async function makeContext(skillNames: string[] = ['spec-writing', 'code-review']): Promise<{ ctx: ThreadToolContext; skillDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'koda-thread-skills-'));
  temporaryDirectories.push(root);
  const skillsRoot = join(root, 'skills');
  const skillDir = join(skillsRoot, 'source-a', 'a'.repeat(40), 'skills', 'spec-writing');
  const skillSources: ThreadSkillSource[] = [{
    sourceId: 'source-a',
    owner: 'owner',
    repo: 'repo',
    sha: 'a'.repeat(40),
    skills: skillNames.map((name) => ({ name, dir: `skills/${name}`, description: `${name} skill` })),
  }];
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# Spec writing\nUse clear requirements.\n');
  await writeFile(join(skillDir, 'references', 'guide.md'), '# Guide\nRead safely.\n');
  return {
    ctx: {
      worktree: root,
      skillsRoot,
      skills: skillSources,
      git: makeGit(),
      searchTimeoutMs: 1_000,
      nowMs: () => 0,
    },
    skillDir,
  };
}

const contentLines = (content: string | undefined): string[] => content?.split('\n') ?? [];

describe('jailed skill tools and assembled tool set (US-004)', () => {
  test('US-004 AC-1: load_skill returns the selected skill SKILL.md text', async () => {
    const { ctx, skillDir } = await makeContext();
    const expected = await Bun.file(join(skillDir, 'SKILL.md')).text();
    const result = await loadSkillModule?.loadSkillTool(ctx).run({ name: 'spec-writing' });
    expect(result?.content).toBe(expected);
  });

  test('US-004 AC-2: unknown skill refusal names every available skill', async () => {
    const { ctx } = await makeContext();
    const result = await loadSkillModule?.loadSkillTool(ctx).run({ name: 'missing' });
    expect([result?.isError, result?.content]).toEqual([true, 'unknown skill missing; available: spec-writing, code-review']);
  });

  test('US-004 AC-3: read_skill_file returns text from a nested file in the selected skill', async () => {
    const { ctx, skillDir } = await makeContext();
    const expected = await Bun.file(join(skillDir, 'references', 'guide.md')).text();
    const result = await readSkillFileModule?.readSkillFileTool(ctx).run({ name: 'spec-writing', relPath: 'references/guide.md' });
    expect(result?.content).toBe(expected);
  });

  test('US-004 AC-4: read_skill_file refuses a relative path escaping the skill directory', async () => {
    const { ctx } = await makeContext();
    const result = await readSkillFileModule?.readSkillFileTool(ctx).run({ name: 'spec-writing', relPath: '../other/SKILL.md' });
    expect(result?.isError).toBe(true);
  });

  test('US-004 AC-5: read_skill_file refuses a symbolic link in the skill directory', async () => {
    const { ctx, skillDir } = await makeContext();
    const linkedFile = join(skillDir, 'linked.md');
    await symlink(join(skillDir, 'SKILL.md'), linkedFile);
    const result = await readSkillFileModule?.readSkillFileTool(ctx).run({ name: 'spec-writing', relPath: 'linked.md' });
    expect(result?.isError).toBe(true);
  });

  test('US-004 AC-6: read_skill_file refuses a file containing a NUL byte', async () => {
    const { ctx, skillDir } = await makeContext();
    await writeFile(join(skillDir, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]));
    const result = await readSkillFileModule?.readSkillFileTool(ctx).run({ name: 'spec-writing', relPath: 'binary.dat' });
    expect(result?.isError).toBe(true);
  });

  test('US-004 AC-7: read_skill_file refuses a text file larger than 262144 bytes', async () => {
    const { ctx, skillDir } = await makeContext();
    await writeFile(join(skillDir, 'large.txt'), 'x'.repeat(262_145));
    const result = await readSkillFileModule?.readSkillFileTool(ctx).run({ name: 'spec-writing', relPath: 'large.txt' });
    expect(result?.isError).toBe(true);
  });

  test('US-004 AC-8: buildThreadTools returns the four tools in their stable order', async () => {
    const { ctx } = await makeContext();
    const tools = toolsIndexModule?.buildThreadTools(ctx);
    expect(tools?.map((tool) => tool.name)).toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file']);
  });

  test('US-004 AC-9: every assembled thread tool has approval set to never', async () => {
    const { ctx } = await makeContext();
    const tools = toolsIndexModule?.buildThreadTools(ctx);
    expect(tools?.map((tool) => tool.approval)).toEqual(['never', 'never', 'never', 'never']);
  });
});
