import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ThreadIngestBatch, ThreadIngestRepository, FoldResult } from './thread-ingestor';
import type { AssistantThreadLine } from './thread-line';

const ERROR_REASON_MAX = 200;

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

  /** Same allocation as `PrismaChatThreadRepository.sendMessage`: the counter, or past the highest existing seq. Caller holds the thread row lock. */
  private async allocateSeq(threadId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ nextSeq: number }>>`UPDATE "ChatThread" SET "nextSeq" = GREATEST("nextSeq", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "ChatMessage" WHERE "threadId" = "ChatThread"."id")) + 1 WHERE "id" = ${threadId} RETURNING "nextSeq" - 1 AS "nextSeq"`;
    const seq = rows[0]?.nextSeq;
    if (seq === undefined) throw new Error(`failed to allocate message sequence for thread ${threadId}`);
    return seq;
  }
}
