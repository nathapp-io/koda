import type { ChatThreadKind } from '../common/thread-jobs';

export const ASSISTANT_TOOL_CALL_REPOSITORY = Symbol('ASSISTANT_TOOL_CALL_REPOSITORY');

export const PROJECT_COUNTS_READER = Symbol('PROJECT_COUNTS_READER');

/** 2a-D4: `pending` is a write tool waiting for the user, `refused` is the thread's per-call cap. */
export type ToolCallOutcome = 'ok' | 'invalid_input' | 'forbidden' | 'not_found' | 'error' | 'pending' | 'refused';

/** One audited tool call. The input is never kept, only its hash. */
export interface AssistantToolCallRecord {
  jobId: string | null;
  threadId: string | null;
  projectId: string | null;
  toolCallId: string | null;
  actorType: 'user' | 'agent';
  actorId: string;
  tool: string;
  inputHash: string;
  outcome: ToolCallOutcome;
  content: string;
  isError: boolean;
  resultBytes: number;
  durationMs: number;
}

/** What the executor needs to know about a THREAD job before it runs a tool for the thread's creator. */
export interface ToolCallContext {
  project: { id: string; slug: string };
  threadId: string;
  creator: { id: string; email: string; role: string; disabled: boolean };
  /** The thread's kind (1d2-D4); absent reads as `REPO`, the column default. */
  kind?: ChatThreadKind;
}

export interface AssistantToolCallRepository {
  findUserActor(userId: string): Promise<{ id: string; email: string; role: string; disabled: boolean } | null>;
  findByCall(jobId: string, toolCallId: string): Promise<AssistantToolCallRecord | null>;
  /** Inserts the row; a concurrent duplicate `(jobId, toolCallId)` surfaces as a unique violation on `toolCallId`. */
  record(row: AssistantToolCallRecord): Promise<void>;
  /** 1b-D6: the job's project, thread and creator in one read; null when the job has no thread. */
  findCallContext(jobId: string): Promise<ToolCallContext | null>;
}

/** 1d2-D7: the three counts `koda_my_projects` prints for one project. */
export interface ProjectCounts {
  openTickets: number;
  failedJobs7d: number;
  pendingApprovals: number;
}

/**
 * 1d2-D7: the escape hatch `koda_my_projects` needs — the ticket, failed-job and pending-approval counts of a set
 * of projects in one read each, keyed by `projectId`. No exported service answers counts for many projects at once,
 * as `findCallContext` crosses FleetJob, ChatThread, User and Project for the executor (1b-D6).
 */
export interface ProjectCountsReader {
  /** A project with no matching row is absent from the counting tables, so its entry keeps zeros. */
  findProjectCounts(projectIds: readonly string[], failedSince: Date): Promise<Map<string, ProjectCounts>>;
}
