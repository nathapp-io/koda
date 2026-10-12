import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ThreadIngestBatch, ThreadIngestRepository, FoldResult } from './thread-ingestor';

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
      if (threadId && !batch.rejectedLine) {
        for (const { line } of batch.lines) {
          const message = await this.prisma.client.chatMessage.findUnique({ where: { id: line.messageId } });
          if (!message || message.threadId !== threadId || message.role !== 'user') throw new Error('input_consumed message does not belong to this thread');
          if (message.status === 'pending') {
            await this.prisma.client.chatMessage.update({ where: { id: message.id }, data: { status: 'complete' } });
          }
        }
      }
      await this.prisma.client.threadIngestCursor.upsert({
        where: { jobId_leaseEpoch: { jobId: batch.jobId, leaseEpoch: batch.leaseEpoch } },
        create: { jobId: batch.jobId, leaseEpoch: batch.leaseEpoch, offset: BigInt(batch.endOffset), skippedLines: batch.badLines },
        update: { offset: BigInt(batch.endOffset), skippedLines: { increment: batch.badLines } },
      });
      return { costChanged: false, events: [] };
    });
  }
}
