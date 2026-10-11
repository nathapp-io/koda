import { fieldOf, refuseInvalidInput } from './shared';
import { checkSkillName, readSkill } from './skill-files';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

async function load(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  return readSkill(ctx, checkSkillName(fieldOf(input, 'name')), 'SKILL.md');
}

/** Returns a skill's SKILL.md text under the read_skill_file rules. */
export function loadSkillTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'load_skill',
    approval: 'never',
    run: (input) => refuseInvalidInput(() => load(ctx, input)),
  };
}
