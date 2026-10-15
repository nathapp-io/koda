import type { EmbedderTool } from '@nathapp/nax-agent';
import { listFilesTool } from './list-files';
import { loadSkillTool } from './load-skill';
import { readSkillFileTool } from './read-skill-file';
import { searchRepoTool } from './search-repo';
import type { ThreadToolContext } from './types';
import { writeDocTool } from './write-doc';

/** The thread agent's tools, in the order the agent sees them, as nax-agent embedder tools. */
export function buildThreadTools(ctx: ThreadToolContext): EmbedderTool[] {
  return [listFilesTool(ctx), searchRepoTool(ctx), loadSkillTool(ctx), readSkillFileTool(ctx), writeDocTool(ctx)];
}

/** A PROJECT thread has no checkout: only the skill tools, over the same context a REPO thread builds. */
export function buildProjectThreadTools(ctx: ThreadToolContext): EmbedderTool[] {
  return [loadSkillTool(ctx), readSkillFileTool(ctx)];
}
