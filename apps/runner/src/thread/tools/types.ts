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
  /** The thread's feature slug. Absent: only `docs/**` is allowlisted (no `.nax/features/<feature>/` prefix can match). */
  feature?: string;
  /** Called after write_doc has written a file; the session counts and reports the write through it. */
  onDocWritten?: (path: string, bytes: number) => void;
}

export interface ThreadToolResult {
  content: string;
  isError?: boolean;
}

/**
 * A thread tool. Assignable to nax-agent's EmbedderTool (its run ignores the session context),
 * so buildThreadTools hands the set straight to a session. Approval is always 'never'.
 */
export interface ThreadTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: EmbedderTool['inputSchema'];
  readonly approval: 'never';
  run(input: unknown): Promise<ThreadToolResult>;
}
