import type { ThreadSkillSource } from '../../../skills/skill-catalog.domain';
import type { ThreadBackend } from '../../common/thread-jobs';
import type { ThreadSendRefusal } from '../thread-send-rules';
import type { PrismaClient } from '../../../generated/prisma/client';

export const CHAT_THREAD_REPOSITORY = Symbol('CHAT_THREAD_REPOSITORY');

/** Counter-based sequence allocation with a fallback past existing rows; caller holds the thread row lock. */
export async function allocateThreadSeq(client: PrismaClient, threadId: string): Promise<number> {
  const rows = await client.$queryRaw<Array<{ nextSeq: number }>>`UPDATE "ChatThread" SET "nextSeq" = GREATEST("nextSeq", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "ChatMessage" WHERE "threadId" = "ChatThread"."id")) + 1 WHERE "id" = ${threadId} RETURNING "nextSeq" - 1 AS "nextSeq"`;
  const seq = rows[0]?.nextSeq;
  if (seq === undefined) throw new Error(`failed to allocate message sequence for thread ${threadId}`);
  return seq;
}

/** The thread's session as the thread stream last folded it (fleet S5a §3.3). `contextReset` is set when the runner lost the transcript on a resume. */
export interface ThreadSession {
  jobId: string;
  state: 'live' | 'closed' | 'failed';
  resumed: boolean;
  contextReset: boolean;
  reason: string | null;
  at: string;
}

/**
 * The thread's last Publish or Discard result (fleet S5a §4), also the `lastWrite` JSON shape. Publish writes
 * `published` or `publish_failed`; Discard writes `discarded` or `discard_failed`.
 */
export type ThreadWriteResult =
  | { kind: 'published'; jobId: string; at: string; sha: string; paths: string[]; ignored: string[] }
  | { kind: 'publish_failed'; jobId: string; at: string; reason: string }
  | { kind: 'discarded'; jobId: string; at: string; sha: string }
  | { kind: 'discard_failed'; jobId: string; at: string; reason: string };

export interface ChatThreadRecord {
  id: string; repoId: string; baseRef: string; feature: string; title: string;
  createdById: string; runnerId: string | null; backend: ThreadBackend; status: string; archivedAt: Date | null;
  skills: ThreadSkillSource[]; maxCostUsd: string; costUsd: string; tokens: unknown; specPath: string;
  pendingQuestion: unknown; session: ThreadSession | null; lastActivityAt: Date; createdAt: Date;
  activeJob: { id: string; state: string } | null;
  /** Distinct paths write_doc touched since the last publish (capped at 200 by the ingest, US-002). */
  writtenPaths: string[];
  publishedSha: string | null;
  specPublished: boolean;
  lastWrite: ThreadWriteResult | null;
}

export type ChatThreadDetail = ChatThreadRecord & { sendRefusal: ThreadSendRefusal | null };

export interface ChatMessageRecord {
  id: string; seq: number; jobId: string | null; turnId: string | null; role: string; authorUserId: string | null;
  clientMessageId: string | null; content: string; toolSummary: unknown; status: string; errorReason: string | null;
  usage: unknown; costUsd: string | null; costSource: string | null; createdAt: Date;
}

export interface ChatThreadRepository {
  create(input: { projectId: string; repoId: string; baseRef: string; feature: string; title: string; createdById: string; backend: ThreadBackend; skills: ThreadSkillSource[]; maxCostUsd: string }): Promise<ChatThreadRecord>;
  list(projectId: string, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]>;
  get(projectId: string, id: string): Promise<ChatThreadRecord | null>;
  sendRefusalOf(projectId: string, thread: ChatThreadRecord): Promise<ThreadSendRefusal | null>;
  messages(threadId: string, afterSeq: number, limit: number): Promise<ChatMessageRecord[]>;
  sendMessage(input: { projectId: string; threadId: string; userId: string; text: string; clientMessageId: string }): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }>;
  archivedThreadIds(runnerId: string): Promise<string[]>;
  updateCap(projectId: string, threadId: string, userId: string, maxCostUsd: string): Promise<ChatThreadRecord>;
  command(projectId: string, threadId: string, userId: string, type: string, payload: object): Promise<void>;
  archive(projectId: string, threadId: string, userId: string, canArchive: boolean): Promise<string | null>;
}
