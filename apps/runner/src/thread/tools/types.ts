import type { EmbedderTool } from '@nathapp/nax-agent';
import type { ThreadSkillSource } from '@nathapp/fleet-protocol';
import type { Git } from '../../executor/git';

export interface ThreadToolContext {
  worktree: string;
  skillsRoot: string;
  skills: ThreadSkillSource[];
  git: Git;
  searchTimeoutMs: number;
  nowMs: () => number;
}

export interface ThreadToolResult {
  content: string;
  isError?: boolean;
}

/**
 * A read-only thread tool. Assignable to nax-agent's EmbedderTool (its run ignores the session context),
 * so buildThreadTools hands the set straight to a session. Approval is always 'never'.
 */
export interface ThreadTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: EmbedderTool['inputSchema'];
  readonly approval: 'never';
  run(input: unknown): Promise<ThreadToolResult>;
}
