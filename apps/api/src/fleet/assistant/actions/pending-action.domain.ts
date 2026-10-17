import type { ChatThreadKind } from '../../common/thread-jobs';

/** 2a-D3: how long a proposed action waits for its creator before the sweeper expires it (24 h). */
export const ACTION_TTL_MS = 86_400_000;

/** 2a-D3: how many actions one thread may have pending at once; the next call is refused, never queued. */
export const MAX_PENDING_ACTIONS = 10;

export const PENDING_ACTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED'] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

export const PENDING_ACTION_REPOSITORY = Symbol('PENDING_ACTION_REPOSITORY');

/**
 * 2a-D3: one koda write-tool call waiting for a decision. `projectSlug` is never a column: every read joins the
 * action's project and fills it, so `checkAction`, `executeAction`, the thread detail and `koda_get_action` read
 * the slug of the project the action acts in rather than the job's or the thread's home project.
 */
export interface PendingActionRecord {
  id: string;
  /** The project the action acts in; for a WORKSPACE call the resolved project. */
  projectId: string;
  /** Slug of `projectId`, filled by every repository read. */
  projectSlug: string;
  threadId: string;
  jobId: string;
  toolCallId: string;
  tool: string;
  /** The tool's parsed input, with the WORKSPACE `project` key already removed. */
  input: Record<string, unknown>;
  preview: string;
  status: PendingActionStatus;
  requestedById: string;
  approvalId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  result: string | null;
  /** Written by `fleet-s5b-koda-actions-web`; this feature only creates the column. */
  deliveredAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/** What one propose call stores. `status` is the column default, `approvalId` is set once the approval exists. */
export interface NewPendingAction {
  projectId: string;
  threadId: string;
  jobId: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  preview: string;
  requestedById: string;
  expiresAt: Date;
}

/** 2a-D4: what `AssistantToolExecutor` hands a proposer for one write call. */
export interface ProposeInput {
  /** The project the action acts in: `ctx.projectId`, already resolved for a WORKSPACE call. */
  projectId: string;
  threadId: string;
  /** The thread's own kind, which decides the path in the approval summary, not the action. */
  threadKind: ChatThreadKind;
  /** The thread's own project slug (`ToolCallContext.project.slug`). */
  threadProjectSlug: string;
  jobId: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  preview: string;
  requestedById: string;
  now: Date;
}

export type ProposeResult = { actionId: string } | { refused: true };

/** 2a-D1: the executor's port to the propose service, attached at init so the provider graph stays acyclic. */
export interface ActionProposer {
  propose(input: ProposeInput): Promise<ProposeResult>;
}

/**
 * 2a-D5: the web path of the thread an action belongs to. A WORKSPACE thread has no project prefix, whatever
 * project its actions act in; every other kind is reachable only inside its project.
 */
export function assistantThreadPath(threadId: string, threadKind: ChatThreadKind, threadProjectSlug: string): string {
  return threadKind === 'WORKSPACE' ? `/threads/${threadId}` : `/${threadProjectSlug}/threads/${threadId}`;
}

/** Module-private: the repository behind `PENDING_ACTION_REPOSITORY` (never exported by the module). */
export interface PendingActionRepository {
  /** `SELECT ... FOR UPDATE` on the thread row (2a-D11 lock order); false when the thread is gone. */
  lockThread(threadId: string): Promise<boolean>;
  /** The action of one call. Its caller holds the thread lock, so the answer is authoritative (2a-D4 step 2). */
  findByCall(jobId: string, toolCallId: string): Promise<PendingActionRecord | null>;
  findById(id: string): Promise<PendingActionRecord | null>;
  /** The thread's PENDING actions, for the per-thread cap (2a-D4 step 3). */
  countPending(threadId: string): Promise<number>;
  insert(action: NewPendingAction): Promise<PendingActionRecord>;
  /** Links the approval `openAssistant` just created (2a-D4 step 6). */
  setApprovalId(id: string, approvalId: string): Promise<void>;
}
