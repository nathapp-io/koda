import type { KodaToolDescriptor } from '@nathapp/fleet-protocol';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ChatThreadKind } from '../common/thread-jobs';

export type ToolOrigin =
  | { kind: 'thread'; threadId: string; jobId: string; threadKind: ChatThreadKind; homeProject: { id: string; slug: string } }
  | { kind: 'mcp' };

export interface ToolCaller {
  principal: UserPrincipal | AgentPrincipal;
  origin: ToolOrigin;
  /** Disabled thread creators are refused; agent callers are never disabled here. */
  disabled: boolean;
}

/** What a tool needs from the acting user: project membership, or a CASL `(action, subject)` ability on top of it. */
export type ToolPermission = { kind: 'member' } | { kind: 'ability'; action: string; subject: string };

export interface ToolContext {
  projectId: string;
  projectSlug: string;
  actor: UserPrincipal | AgentPrincipal;
  threadId: string | null;
  jobId: string | null;
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
  /** 2a-D2: a `write` tool is previewed and proposed, never executed; absent means `read`. */
  kind?: 'read' | 'write';
  /** 2a-D2: what the user approves, so a `write` tool must have one. The executor calls it instead of `execute`. */
  preview?(ctx: ToolContext, input: I): Promise<string>;
  /** Throws ToolInputError(reason) for input the tool cannot use. */
  parse(input: unknown): I;
  execute(ctx: ToolContext, input: I): Promise<string>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** Longest `detail` an `invalid_input` refusal carries. */
const MAX_INPUT_DETAIL_CHARS = 200;

/**
 * A tool's parser or preview refuses the input; the executor answers `invalid_input: <reason>`, or
 * `invalid_input: <reason>: <detail>` when the field alone does not say why (#299). A detail is built from
 * server-side values only (enum states, a validated ref), never from untrusted text such as a ticket title.
 */
export class ToolInputError extends Error {
  constructor(readonly reason: string, readonly detail?: string) {
    super(reason);
    this.name = 'ToolInputError';
  }

  /** The refusal text the agent reads. */
  get refusalText(): string {
    return this.detail ? `invalid_input: ${this.reason}: ${this.detail.slice(0, MAX_INPUT_DETAIL_CHARS)}` : `invalid_input: ${this.reason}`;
  }
}

/** 2b1-D1: a write tool's preview refuses because the requester lacks an ability; `need` is the `<action> <subject>` pair. */
export class ToolForbiddenError extends Error {
  constructor(readonly need: string) {
    super(need);
    this.name = 'ToolForbiddenError';
  }
}

/** 2b1-D2: an approved tool failed partway; `text` is the outcome and quotes what it already wrote. */
export class ToolActionError extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = 'ToolActionError';
  }
}
