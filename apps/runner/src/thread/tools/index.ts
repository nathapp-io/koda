import { listFilesTool } from './list-files';
import { loadSkillTool } from './load-skill';
import { readSkillFileTool } from './read-skill-file';
import { searchRepoTool } from './search-repo';
import type { ThreadTool, ThreadToolContext } from './types';

/** The thread agent's read-only tools, in the order the agent sees them. */
export function buildThreadTools(ctx: ThreadToolContext): ThreadTool[] {
  return [listFilesTool(ctx), searchRepoTool(ctx), loadSkillTool(ctx), readSkillFileTool(ctx)];
}
