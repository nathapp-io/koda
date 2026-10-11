import { fieldOf, refuseInvalidInput } from './shared';
import { checkSkillName, readSkill } from './skill-files';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

async function read(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  return readSkill(ctx, checkSkillName(fieldOf(input, 'name')), fieldOf(input, 'relPath'));
}

/** Reads a file inside one skill directory; the path may not leave it. */
export function readSkillFileTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'read_skill_file',
    approval: 'never',
    run: (input) => refuseInvalidInput(() => read(ctx, input)),
  };
}
