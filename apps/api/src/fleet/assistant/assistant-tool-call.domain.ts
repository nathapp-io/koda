import type { ChatThreadKind } from '../common/thread-jobs';

export const ASSISTANT_TOOL_CALL_REPOSITORY = Symbol('ASSISTANT_TOOL_CALL_REPOSITORY');

export type ToolCallOutcome = 'ok' | 'invalid_input' | 'forbidden' | 'not_found' | 'error';

/** One audited tool call. The input is never kept, only its hash. */
export interface AssistantToolCallRecord {
  jobId: string;
  threadId: string;
  projectId: string;
  toolCallId: string;
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
  findByCall(jobId: string, toolCallId: string): Promise<AssistantToolCallRecord | null>;
  /** Inserts the row; a concurrent duplicate `(jobId, toolCallId)` surfaces as a unique violation on `toolCallId`. */
  record(row: AssistantToolCallRecord): Promise<void>;
  /** 1b-D6: the job's project, thread and creator in one read; null when the job has no thread. */
  findCallContext(jobId: string): Promise<ToolCallContext | null>;
}
