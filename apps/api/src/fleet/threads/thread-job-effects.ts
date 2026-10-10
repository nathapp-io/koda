import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { FleetCommandType } from '../../common/enums';
import { isThreadKind, THREAD_LIMITS } from '../common/thread-jobs';
import type { FleetCommandRecord, FleetJobRecord } from '../jobs/domain/fleet-job.domain';

@Injectable()
export class ThreadJobEffects {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async onInputAck(command: FleetCommandRecord, result: string, detail: string): Promise<void> {
    if (command.type === FleetCommandType.THREAD_INPUT) {
      const { messageId } = command.payload as { messageId?: unknown };
      if (typeof messageId === 'string' && result === 'rejected') await this.prisma.client.chatMessage.updateMany({ where: { id: messageId }, data: { status: 'errored', errorReason: detail.slice(0, 200) } });
      if (typeof messageId === 'string') await this.replaceCommandPayload(command.id, { messageId });
    } else if (command.type === FleetCommandType.THREAD_ANSWER) {
      const { requestId } = command.payload as { requestId?: unknown };
      await this.replaceCommandPayload(command.id, { requestId });
    }
  }

  async onJobEnded(job: FleetJobRecord): Promise<void> {
    if (!isThreadKind(job.command) || !job.threadId) return;
    await this.prisma.client.chatMessage.updateMany({ where: { threadId: job.threadId, status: { in: ['pending', 'streaming'] } }, data: { status: 'errored', errorReason: job.state.toLowerCase() } });
    await this.prisma.client.chatThread.updateMany({ where: { id: job.threadId }, data: { pendingQuestion: Prisma.DbNull } });
  }

  async replaceCommandPayload(commandId: string, payload: unknown): Promise<void> {
    await this.prisma.client.fleetCommand.update({ where: { id: commandId }, data: { payload: payload as Prisma.InputJsonValue } });
  }

  async archivedThreadIds(runnerId: string): Promise<string[]> {
    const rows = await this.prisma.client.chatThread.findMany({ where: { runnerId, status: 'ARCHIVED' }, orderBy: [{ archivedAt: 'desc' }, { id: 'desc' }], take: THREAD_LIMITS.maxArchivedThreadIds, select: { id: true } });
    return rows.map((row) => row.id);
  }
}
