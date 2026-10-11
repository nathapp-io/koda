import { assertRelativePath } from '../../paths/safe-segment';
import { fieldOf, refuseInvalidInput } from './shared';
import { checkSkillName, readSkill } from './skill-files';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

async function read(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  const name = checkSkillName(fieldOf(input, 'name'));
  const relPath = assertRelativePath('relPath', fieldOf(input, 'relPath'));
  return readSkill(ctx, name, relPath);
}

/** Reads a file inside one skill directory; the path may not leave it. */
export function readSkillFileTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'read_skill_file',
    approval: 'never',
    run: (input) => refuseInvalidInput(() => read(ctx, input)),
  };
}
