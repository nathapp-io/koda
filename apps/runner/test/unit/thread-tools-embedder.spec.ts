import { describe, expect, test } from 'bun:test';
import type { CreateAgentSessionOptions } from '@nathapp/nax-agent';
import { buildThreadTools } from '../../src/thread/tools';
import type { ThreadToolContext } from '../../src/thread/tools/types';

const ctx: ThreadToolContext = {
  worktree: '/tmp/unused-worktree',
  skillsRoot: '/tmp/unused-skills',
  skills: [],
  git: {} as ThreadToolContext['git'],
  searchTimeoutMs: 1000,
  nowMs: () => 0,
};

describe('buildThreadTools as nax-agent embedder tools', () => {
  test('every tool carries a name, a description, an object input schema and approval never', () => {
    const tools = buildThreadTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual(['list_files', 'search_repo', 'load_skill', 'read_skill_file']);
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.approval).toBe('never');
    }
  });

  test('the tool set is assignable to the session options tools field', () => {
    const tools: NonNullable<CreateAgentSessionOptions['tools']> = buildThreadTools(ctx);
    expect(tools.length).toBe(4);
  });
});
