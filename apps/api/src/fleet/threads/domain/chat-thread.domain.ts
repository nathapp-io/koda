import type { ThreadSkillSource } from '../../../skills/skill-catalog.domain';
import type { ThreadBackend } from '../../common/thread-jobs';

export const CHAT_THREAD_REPOSITORY = Symbol('CHAT_THREAD_REPOSITORY');

export interface ChatThreadRecord {
  id: string; repoId: string; baseRef: string; feature: string; title: string;
  createdById: string; runnerId: string | null; backend: ThreadBackend; status: string; archivedAt: Date | null;
  skills: ThreadSkillSource[]; maxCostUsd: string; costUsd: string; tokens: unknown; specPath: string;
  pendingQuestion: unknown; lastActivityAt: Date; createdAt: Date;
  activeJob: { id: string; state: string } | null;
}

export interface ChatMessageRecord {
  id: string; seq: number; jobId: string | null; turnId: string | null; role: string; authorUserId: string | null;
  clientMessageId: string | null; content: string; toolSummary: unknown; status: string; errorReason: string | null;
  usage: unknown; costUsd: string | null; costSource: string | null; createdAt: Date;
}

export interface ChatThreadRepository {
  create(input: { projectId: string; repoId: string; baseRef: string; feature: string; title: string; createdById: string; backend: ThreadBackend; skills: ThreadSkillSource[]; maxCostUsd: string }): Promise<ChatThreadRecord>;
  list(projectId: string, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]>;
  get(projectId: string, id: string): Promise<ChatThreadRecord | null>;
  messages(threadId: string, afterSeq: number, limit: number): Promise<ChatMessageRecord[]>;
}
