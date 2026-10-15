import { describe, expect, test } from 'bun:test';
import type { Git } from '../../src/executor/git';
import { threadScratchDir } from '../../src/thread/thread-paths';
import { buildProjectThreadTools } from '../../src/thread/tools';

describe('PROJECT thread kit (US-006)', () => {
  test('US-006 AC-6: threadScratchDir sits under the thread directory', () => {
    expect(threadScratchDir('/home/r', 't1')).toBe('/home/r/threads/t1/scratch');
  });

  test('US-006 AC-6: threadScratchDir refuses an unsafe thread id', () => {
    expect(() => threadScratchDir('/home/r', '../x')).toThrow();
  });

  test('US-006 AC-7: buildProjectThreadTools returns only the two skill tools', () => {
    const tools = buildProjectThreadTools({
      worktree: '/home/r/threads/t1/scratch', skillsRoot: '/home/r/skills', skills: [],
      git: {} as Git, searchTimeoutMs: 1_000, nowMs: () => 0,
    });
    expect(tools.map((tool) => tool.name)).toEqual(['load_skill', 'read_skill_file']);
  });
});
