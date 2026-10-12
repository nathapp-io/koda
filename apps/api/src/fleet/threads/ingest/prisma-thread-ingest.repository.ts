import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ThreadIngestBatch, ThreadIngestRepository, FoldResult } from './thread-ingestor';
import type { AssistantThreadLine, QuestionThreadLine, SessionThreadLine, ThreadLine, ToolThreadLine } from './thread-line';
import {
  linkApprovalRequest, setApprovalDecision, setToolResult, upsertInformationalQuestion, upsertToolCall, type ToolSummaryEntry,
} from './tool-summary';

const ERROR_REASON_MAX = 200;

const QUESTION_TEXT_MAX = 2048;

/** A ThreadSession as stored in `ChatThread.session` (the API `session` JSON). */
interface StoredSession { jobId: string; state: 'live' | 'closed' | 'failed'; resumed: boolean; contextReset: boolean; reason: string | null; at: string }

/** Reads a message's stored `toolSummary` (JSON, written only by this fold) as its typed entries. */
const readSummary = (json: Prisma.JsonValue | null): ToolSummaryEntry[] => (json as unknown as ToolSummaryEntry[] | null) ?? [];

const isToolLine = (line: ThreadLine): line is ToolThreadLine =>
  line.type === 'tool_call' || line.type === 'tool_result' || line.type === 'approval_requested' || line.type === 'approval_resolved';
const isSessionLine = (line: ThreadLine): line is SessionThreadLine =>
  line.type === 'session_started' || line.type === 'session_closed' || line.type === 'session_failed';

@Injectable()
export class PrismaThreadIngestRepository implements ThreadIngestRepository {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async readCursor(jobId: string, leaseEpoch: number): Promise<{ offset: number; skippedLines: number }> {
    const cursor = await this.prisma.client.threadIngestCursor.findUnique({
      where: { jobId_leaseEpoch: { jobId, leaseEpoch } },
      select: { offset: true, skippedLines: true },
    });
    return { offset: Number(cursor?.offset ?? 0n), skippedLines: cursor?.skippedLines ?? 0 };
  }

  async fold(batch: ThreadIngestBatch): Promise<FoldResult> {
    return this.txManager.run(async () => {
      await this.prisma.client.$queryRaw`SELECT "id" FROM "FleetJob" WHERE "id" = ${batch.jobId} FOR UPDATE`;
      const job = await this.prisma.client.fleetJob.findUnique({
        where: { id: batch.jobId }, select: { id: true, command: true, threadId: true },
      });
      let threadId: string | null = null;
      if (job?.command === 'THREAD' && job.threadId) {
        await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${job.threadId} FOR UPDATE`;
        threadId = job.threadId;
      }
      let skippedLines = 0;
      if (threadId && !batch.rejectedLine) {
        for (const { line } of batch.lines) {
          if (line.type === 'input_consumed') await this.foldInputConsumed(threadId, line.messageId);
          else if (isToolLine(line)) skippedLines += await this.foldToolLine(threadId, line);
          else if (line.type === 'question') skippedLines += await this.foldQuestion(threadId, line);
          else if (isSessionLine(line)) await this.foldSessionLine(batch, threadId, line);
          else skippedLines += await this.foldAssistantLine(batch, threadId, line);
        }
      }
      await this.prisma.client.threadIngestCursor.upsert({
        where: { jobId_leaseEpoch: { jobId: batch.jobId, leaseEpoch: batch.leaseEpoch } },
        create: { jobId: batch.jobId, leaseEpoch: batch.leaseEpoch, offset: BigInt(batch.endOffset), skippedLines: batch.badLines + skippedLines },
        update: { offset: BigInt(batch.endOffset), skippedLines: { increment: batch.badLines + skippedLines } },
      });
      return { costChanged: false, events: [] };
    });
  }

  private async foldInputConsumed(threadId: string, messageId: string): Promise<void> {
    const message = await this.prisma.client.chatMessage.findUnique({ where: { id: messageId } });
    if (!message || message.threadId !== threadId || message.role !== 'user') throw new Error('input_consumed message does not belong to this thread');
    if (message.status === 'pending') {
      await this.prisma.client.chatMessage.update({ where: { id: message.id }, data: { status: 'complete' } });
    }
  }

  /** Folds one assistant-side line. Returns 1 when the line is bad (unknown or duplicate turn), else 0. */
  private async foldAssistantLine(batch: ThreadIngestBatch, threadId: string, line: AssistantThreadLine): Promise<number> {
    const db = this.prisma.client;
    if (line.type === 'turn_start') {
      const existing = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' }, select: { id: true } });
      if (existing) return 1;
      const seq = await this.allocateSeq(threadId);
      await db.chatMessage.create({ data: { threadId, seq, role: 'assistant', status: 'streaming', content: '', jobId: batch.jobId, turnId: line.turnId } });
      return 0;
    }
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' } });
    if (!message) return 1;
    if (line.type === 'text_delta') {
      const roundChanged = message.streamRound !== line.round;
      await db.chatMessage.update({ where: { id: message.id }, data: {
        content: message.content + line.text,
        ...(roundChanged ? { streamRound: line.round, streamRoundStart: message.content.length } : {}),
      } });
      return 0;
    }
    if (line.type === 'stream_reset') {
      if (message.streamRound === line.round && message.streamRoundStart !== null) {
        await db.chatMessage.update({ where: { id: message.id }, data: { content: message.content.slice(0, message.streamRoundStart) } });
      }
      return 0;
    }
    const finalOutput = line.status === 'completed' && line.output !== '' && line.outputTruncated !== true;
    const streaming = message.status === 'streaming';
    await db.chatMessage.update({ where: { id: message.id }, data: {
      ...(finalOutput ? { content: line.output } : {}),
      ...(streaming ? { status: line.status === 'completed' ? 'complete' : line.status } : {}),
      ...(streaming && line.status === 'errored' ? { errorReason: (line.error?.message ?? line.error?.code ?? null)?.slice(0, ERROR_REASON_MAX) ?? null } : {}),
    } });
    await db.chatThread.update({ where: { id: threadId }, data: { pendingQuestion: Prisma.DbNull, lastActivityAt: new Date() } });
    return 0;
  }

  /**
   * Folds a tool or approval line into the `toolSummary` of the turn's assistant message. Approval lines carry no turnId,
   * so they match the message whose summary already holds the request. Returns 1 for a tool_* line with no message.
   */
  private async foldToolLine(threadId: string, line: ToolThreadLine): Promise<number> {
    const db = this.prisma.client;
    if (line.type === 'approval_requested' && line.callId === undefined) return 0;
    if (line.type === 'approval_requested' || line.type === 'approval_resolved') {
      // The message whose summary holds the call (requested) or the request (resolved). Matched by containment on the JSON.
      // Newest first, so a callId reused across turns always resolves to the same message.
      const holds = line.type === 'approval_requested' ? { callId: line.callId } : { requestId: line.requestId };
      const message = await db.chatMessage.findFirst({
        where: { threadId, role: 'assistant', toolSummary: { array_contains: [holds] } },
        orderBy: { seq: 'desc' },
        select: { id: true, toolSummary: true },
      });
      if (!message) return 0;
      const entries = readSummary(message.toolSummary);
      const next = line.type === 'approval_requested'
        ? linkApprovalRequest(entries, line.callId as string, line.requestId)
        : setApprovalDecision(entries, line.requestId, line.decidedBy);
      await db.chatMessage.update({ where: { id: message.id }, data: { toolSummary: next as unknown as Prisma.InputJsonValue } });
      return 0;
    }
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' }, select: { id: true, toolSummary: true } });
    if (!message) return 1;
    const entries = readSummary(message.toolSummary);
    const next = line.type === 'tool_call'
      ? upsertToolCall(entries, { callId: line.callId, name: line.name, input: line.input })
      : setToolResult(entries, line.callId, line.isError, line.preview);
    await db.chatMessage.update({ where: { id: message.id }, data: { toolSummary: next as unknown as Prisma.InputJsonValue } });
    return 0;
  }

  /**
   * An answerable question sets the thread's `pendingQuestion`; an informational one becomes an `ask_human` tool entry.
   * Returns 1 when an informational question names a turn with no assistant message, else 0.
   */
  private async foldQuestion(threadId: string, line: QuestionThreadLine): Promise<number> {
    const db = this.prisma.client;
    if (line.answerable) {
      await db.chatThread.update({ where: { id: threadId }, data: {
        pendingQuestion: { requestId: line.requestId, text: [...line.text].slice(0, QUESTION_TEXT_MAX).join(''), expiresAt: line.expiresAt },
      } });
      return 0;
    }
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' }, select: { id: true, toolSummary: true } });
    if (!message) return 1;
    const next = upsertInformationalQuestion(readSummary(message.toolSummary), line.requestId, line.text);
    await db.chatMessage.update({ where: { id: message.id }, data: { toolSummary: next as unknown as Prisma.InputJsonValue } });
    return 0;
  }

  /**
   * Folds a runner session line into `ChatThread.session`. `session_failed` also errors the thread's pending and
   * streaming messages with the reason, keeping their content (fleet S5a §8).
   */
  private async foldSessionLine(batch: ThreadIngestBatch, threadId: string, line: SessionThreadLine): Promise<void> {
    const db = this.prisma.client;
    const at = line.at ?? new Date().toISOString();
    if (line.type === 'session_started') {
      const turn = await db.fleetThreadTurn.findUnique({ where: { jobId: batch.jobId }, select: { resume: true } });
      const session: StoredSession = { jobId: batch.jobId, state: 'live', resumed: line.resumed, contextReset: turn?.resume === true && !line.resumed, reason: null, at };
      await db.chatThread.update({ where: { id: threadId }, data: { session: session as unknown as Prisma.InputJsonValue } });
      return;
    }
    // A close or failure keeps resumed and contextReset only when the stored session belongs to this job; otherwise
    // (no session yet, or a previous job's session) they are false, so a new job never inherits the old flags.
    const previous = (await db.chatThread.findUnique({ where: { id: threadId }, select: { session: true } }))?.session as unknown as StoredSession | null | undefined;
    const current = previous?.jobId === batch.jobId ? previous : null;
    const session: StoredSession = {
      jobId: batch.jobId,
      state: line.type === 'session_closed' ? 'closed' : 'failed',
      resumed: current?.resumed ?? false,
      contextReset: current?.contextReset ?? false,
      reason: line.reason,
      at,
    };
    await db.chatThread.update({ where: { id: threadId }, data: { session: session as unknown as Prisma.InputJsonValue } });
    if (line.type === 'session_failed') {
      await db.chatMessage.updateMany({
        where: { threadId, status: { in: ['pending', 'streaming'] } },
        data: { status: 'errored', errorReason: line.reason.slice(0, ERROR_REASON_MAX) },
      });
    }
  }

  /** Same allocation as `PrismaChatThreadRepository.sendMessage`: the counter, or past the highest existing seq. Caller holds the thread row lock. */
  private async allocateSeq(threadId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ nextSeq: number }>>`UPDATE "ChatThread" SET "nextSeq" = GREATEST("nextSeq", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "ChatMessage" WHERE "threadId" = "ChatThread"."id")) + 1 WHERE "id" = ${threadId} RETURNING "nextSeq" - 1 AS "nextSeq"`;
    const seq = rows[0]?.nextSeq;
    if (seq === undefined) throw new Error(`failed to allocate message sequence for thread ${threadId}`);
    return seq;
  }
}
