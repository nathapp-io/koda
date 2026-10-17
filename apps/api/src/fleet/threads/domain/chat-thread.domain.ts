import type { ThreadSkillSource } from '../../../skills/skill-catalog.domain';
import type { ChatThreadKind, ThreadBackend } from '../../common/thread-jobs';
import type { ThreadSendRefusal } from '../thread-send-rules';
import type { PrismaClient } from '../../../generated/prisma/client';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';

export const CHAT_THREAD_REPOSITORY = Symbol('CHAT_THREAD_REPOSITORY');

/** The repo fields of a REPO thread, all present. */
export interface RepoThreadFields { repoId: string; baseRef: string; feature: string; specPath: string }

/**
 * The REPO-only guard (fleet S5b §1a-R3): the repo fields of a thread whose kind is REPO. A PROJECT or WORKSPACE
 * thread, and a REPO row whose `kind` is missing or unknown (rows written before the kind column, and unit fixtures),
 * is judged by the four fields alone. Every REPO-only consumer — Plan, Run, Publish, Discard, the THREAD job factory
 * and the ASSIGN and cost-event fallbacks — reads the fields through this one function, so the refusal is uniform.
 */
export function repoThreadFields(thread: {
  kind?: string;
  repoId: string | null;
  baseRef: string | null;
  feature: string | null;
  specPath: string | null;
}): RepoThreadFields {
  const { repoId, baseRef, feature, specPath } = thread;
  // Fleet S5b 1d: a WORKSPACE thread owns no repo either; the create paths never give one repo fields, so this only
  // catches a row that predates the refusal.
  if (thread.kind === 'PROJECT' || thread.kind === 'WORKSPACE' || repoId === null || baseRef === null || feature === null || specPath === null) {
    throw new ConflictAppException({}, 'threads.notRepoThread');
  }
  return { repoId, baseRef, feature, specPath };
}

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
  /** Set while the runner reports the session's worktree stale; absent otherwise (fleet S5a §4). */
  stale?: true;
  /** Fleet S5b 1b-D4: the runner hosting this session does not advertise `kodaTools`, so its sessions get none. */
  kodaToolsUnavailableOn?: string;
  /**
   * Fleet S5b 1c-b-D8: the runner hosting this PROJECT session does not advertise `projectCode`, so the session reads
   * no project code. Absent on a REPO thread's session and on a runner that advertised the capability.
   */
  projectCodeUnavailableOn?: string;
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
  id: string; kind: ChatThreadKind; projectId: string; repoId: string | null; baseRef: string | null; feature: string | null;
  title: string;
  createdById: string; runnerId: string | null; backend: ThreadBackend; status: string; archivedAt: Date | null;
  skills: ThreadSkillSource[]; maxCostUsd: string; costUsd: string; tokens: unknown; specPath: string | null;
  pendingQuestion: unknown; session: ThreadSession | null; lastActivityAt: Date; createdAt: Date;
  activeJob: { id: string; state: string } | null;
  /** Distinct paths write_doc touched since the last publish (capped at 200 by the ingest, US-002). */
  writtenPaths: string[];
  publishedSha: string | null;
  specPublished: boolean;
  lastWrite: ThreadWriteResult | null;
  /** Fleet S5b 1d: set only by a workspace-scope read (US-002); a project-scope record never carries it. */
  homeProject?: { slug: string; name: string };
}

export interface ThreadHandoffJob { jobId: string; state: string; stateReason: string | null }
export type ChatThreadHandoff = { plan: ThreadHandoffJob | null; run: ThreadHandoffJob | null };

/**
 * S5b 2a-D12: one `PENDING` action of a thread, as the thread detail shows it. `projectSlug` is the slug of the
 * project the action acts in — for a WORKSPACE call the resolved project — never the thread's home project.
 */
export interface ChatThreadPendingAction {
  id: string;
  approvalId: string | null;
  tool: string;
  preview: string;
  projectSlug: string;
  expiresAt: Date;
  createdAt: Date;
}

export type ChatThreadDetail = ChatThreadRecord & {
  sendRefusal: ThreadSendRefusal | null;
  handoff: ChatThreadHandoff;
  /** Oldest first, at most `MAX_PENDING_ACTIONS`; empty for a thread whose actions are all decided (2a-D12). */
  pendingActions: ChatThreadPendingAction[];
};

export interface ChatMessageRecord {
  id: string; seq: number; jobId: string | null; turnId: string | null; role: string; authorUserId: string | null;
  clientMessageId: string | null; content: string; toolSummary: unknown; status: string; errorReason: string | null;
  usage: unknown; costUsd: string | null; costSource: string | null; createdAt: Date;
}

/** Which threads a lookup may see: a project's REPO and PROJECT threads, or one user's WORKSPACE threads. */
export type ThreadScope = { kind: 'project'; projectId: string } | { kind: 'workspace'; userId: string };

export interface ChatThreadRepository {
  create(input: { kind: ChatThreadKind; projectId: string; repoId: string | null; baseRef: string | null; feature: string | null; title: string; createdById: string; backend: ThreadBackend; skills: ThreadSkillSource[]; maxCostUsd: string }): Promise<ChatThreadRecord>;
  list(scope: ThreadScope, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]>;
  get(scope: ThreadScope, id: string): Promise<ChatThreadRecord | null>;
  handoff(threadId: string): Promise<ChatThreadHandoff>;
  /** 2a-D12: the reader's own preview of the thread's open actions; the same thread fence as `get`. */
  pendingActions(threadId: string): Promise<ChatThreadPendingAction[]>;
  sendRefusalOf(projectId: string, thread: ChatThreadRecord): Promise<ThreadSendRefusal | null>;
  messages(threadId: string, afterSeq: number, limit: number): Promise<ChatMessageRecord[]>;
  sendMessage(input: { scope: ThreadScope; threadId: string; userId: string; text: string; clientMessageId: string; repoContext?: string }): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }>;
  publish(projectId: string, threadId: string, userId: string): Promise<{ jobId: string | null }>;
  discard(projectId: string, threadId: string, userId: string): Promise<{ jobId: string }>;
  archivedThreadIds(runnerId: string): Promise<string[]>;
  updateCap(scope: ThreadScope, threadId: string, userId: string, maxCostUsd: string): Promise<ChatThreadRecord>;
  command(scope: ThreadScope, threadId: string, userId: string, type: string, payload: object): Promise<void>;
  archive(scope: ThreadScope, threadId: string, userId: string, canArchive: boolean): Promise<string | null>;
}
