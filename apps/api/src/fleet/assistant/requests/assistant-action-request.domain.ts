import type { ApprovalRequestStatus } from '../../../approvals/domain/approval.domain';

export const ASSISTANT_ACTION_REQUEST_REPOSITORY = Symbol('ASSISTANT_ACTION_REQUEST_REPOSITORY');
export const MAX_PENDING_ACTIONS = 10;

export interface AssistantActionRequestRecord {
  requestId: string;
  threadId: string | null;
  jobId: string | null;
  toolCallId: string | null;
  tool: string;
  preview: string;
  noteMessageId: string | null;
  notedAt: Date | null;
  deliveredAt: Date | null;
  deliveredMessageId: string | null;
  createdAt: Date;
}
export interface NewAssistantActionRequest extends Pick<AssistantActionRequestRecord, 'requestId' | 'threadId' | 'jobId' | 'toolCallId' | 'tool' | 'preview'> {}
export interface LinkedApprovalRequest extends AssistantActionRequestRecord { request: { id: string; projectId: string | null; status: ApprovalRequestStatus; createdAt: Date; decidedAt: Date | null; settledAt: Date | null; result: unknown } }
export type OwnApprovalRequest = { id: string; projectId: string | null; actorType: string; actorId: string; assistantAction: AssistantActionRequestRecord | null };
export interface AssistantActionRequestRepository {
  insert(link: NewAssistantActionRequest): Promise<AssistantActionRequestRecord>;
  findByRequest(requestId: string): Promise<AssistantActionRequestRecord | null>;
  lockThread(threadId: string): Promise<boolean>;
  lockByRequest(requestId: string): Promise<AssistantActionRequestRecord | null>;
  insertSystemNote(threadId: string, content: string): Promise<string>;
  markNoted(requestId: string, noteMessageId: string, at: Date): Promise<void>;
  countPendingInThread(threadId: string): Promise<number>;
  findScopedInThread(requestId: string, projectId: string, threadId: string): Promise<LinkedApprovalRequest | null>;
  findOwnRequest(requestId: string, projectId: string, actor: { type: 'USER' | 'AGENT'; id: string }): Promise<OwnApprovalRequest | null>;
}
