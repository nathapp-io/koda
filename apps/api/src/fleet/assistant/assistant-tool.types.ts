import type { KodaToolDescriptor } from '@nathapp/fleet-protocol';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';

/** What a tool needs from the acting user: project membership, or a CASL `(action, subject)` ability on top of it. */
export type ToolPermission = { kind: 'member' } | { kind: 'ability'; action: string; subject: string };

export interface ToolContext {
  projectId: string;
  projectSlug: string;
  actor: UserPrincipal;
  threadId: string;
  jobId: string;
  now: Date;
  /** Masks secrets, then wraps the text in this call's fence. Every user-written field goes through it. */
  data(text: string): string;
}

export interface AssistantTool<I = unknown> {
  /** One of KODA_TOOL_DESCRIPTORS. */
  descriptor: KodaToolDescriptor;
  permission: ToolPermission;
  /** 1d2-D3: `workspace` tools run only in WORKSPACE threads and take no `project`; absent means `project`. */
  scope?: 'project' | 'workspace';
  /** Throws ToolInputError(reason) for input the tool cannot use. */
  parse(input: unknown): I;
  execute(ctx: ToolContext, input: I): Promise<string>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** A tool's parser refuses the input; the executor answers `invalid_input: <reason>`. */
export class ToolInputError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ToolInputError';
  }
}
