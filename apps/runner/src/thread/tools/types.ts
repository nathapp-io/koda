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

/** Thread tools are read-only, so nax-agent never asks for approval before running one. */
export interface ThreadTool {
  readonly name: string;
  readonly approval: 'never';
  run(input: unknown): Promise<ThreadToolResult>;
}
