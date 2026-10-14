import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import type { ThreadLiveEvent } from '../../live/thread-event-bus';
import { isThreadKind } from '../common/thread-jobs';
import type { FleetCommandRecord, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { ThreadSession, ThreadWriteResult } from './domain/chat-thread.domain';

/** Job ends that mean the runner died or failed; the session snapshot shows them as `failed`, the rest as `closed`. */
const FAILED_END_STATES: readonly string[] = [FleetJobState.CRASHED, FleetJobState.FAILED];

/**
 * The effects of a THREAD command ack and of a THREAD job ending, run inside the ack and the
 * terminal-transition transaction. `archivedThreadIds` is a read, so it stays on
 * `CHAT_THREAD_REPOSITORY`, which SyncModule already imports through ThreadStoreModule.
 */
@Injectable()
export class ThreadJobEffects {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async onInputAck(command: FleetCommandRecord, result: string, detail: string): Promise<void> {
    if (command.type === FleetCommandType.THREAD_PUBLISH) {
      await this.onPublishAck(command, result, detail);
    } else if (command.type === FleetCommandType.THREAD_INPUT) {
      const { messageId } = command.payload as { messageId?: unknown };
      if (typeof messageId === 'string' && result === 'rejected') await this.prisma.client.chatMessage.updateMany({ where: { id: messageId }, data: { status: 'errored', errorReason: detail.slice(0, 200) } });
      if (typeof messageId === 'string') await this.replaceCommandPayload(command.id, { messageId });
    } else if (command.type === FleetCommandType.THREAD_ANSWER) {
      const { requestId } = command.payload as { requestId?: unknown };
      if (result === 'ok' && typeof requestId === 'string') await this.clearAnsweredQuestion(command.jobId, requestId);
      await this.replaceCommandPayload(command.id, { requestId });
    }
  }

  /**
   * A THREAD job ended: its pending and streaming messages become errored, its pending question clears and a live
   * session snapshot of this job closes. Runs inside the terminal transition; the returned live events are published
   * only after that transition commits (fleet S5a #264), so an open page refetches the messages and the thread.
   */
  async onJobEnded(job: FleetJobRecord): Promise<ThreadLiveEvent[]> {
    if (!isThreadKind(job.command) || !job.threadId) return [];
    const threadId = job.threadId;
    // Lock order job -> thread -> messages, like the ingest fold and send; it also keeps findMany and updateMany on one set.
    await this.prisma.client.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
    const where = { threadId, status: { in: ['pending', 'streaming'] } };
    const open = await this.prisma.client.chatMessage.findMany({ where, select: { id: true } });
    await this.prisma.client.chatMessage.updateMany({ where, data: { status: 'errored', errorReason: job.state.toLowerCase() } });
    await this.prisma.client.chatThread.updateMany({ where: { id: threadId }, data: { pendingQuestion: Prisma.DbNull } });
    const at = (job.finishedAt ?? new Date()).toISOString();
    await this.closeSnapshot(job, threadId, at);
    const base = { threadId, at };
    const messageEvents: ThreadLiveEvent[] = open.map(({ id }) => ({ ...base, id: randomUUID(), type: 'message', messageId: id }));
    return [...messageEvents, { ...base, id: randomUUID(), type: 'thread' }];
  }

  /** Closes the session snapshot only while it is still `live` and belongs to this job; the runner's own close wins. */
  private async closeSnapshot(job: FleetJobRecord, threadId: string, at: string): Promise<void> {
    const thread = await this.prisma.client.chatThread.findUnique({ where: { id: threadId }, select: { session: true } });
    const session = thread?.session as unknown as ThreadSession | null | undefined;
    if (!session || session.jobId !== job.id || session.state !== 'live') return;
    const closed: ThreadSession = {
      ...session,
      state: FAILED_END_STATES.includes(job.state) ? 'failed' : 'closed',
      reason: job.stateReason ?? job.state.toLowerCase(),
      at,
    };
    await this.prisma.client.chatThread.update({ where: { id: threadId }, data: { session: closed as unknown as Prisma.InputJsonValue } });
  }

  /**
   * A rejected Publish ack records `publish_failed` on the thread so the page can show why. A `publishing` detail is
   * a second click while the first publish runs; its own result line follows and must not be overwritten. An ok ack
   * writes nothing: the `published` line follows on the stream (fleet S5a §4). Caller holds the job lock.
   */
  private async onPublishAck(command: FleetCommandRecord, result: string, detail: string): Promise<void> {
    if (result !== 'rejected' || detail === 'publishing') return;
    const job = await this.prisma.client.fleetJob.findUnique({ where: { id: command.jobId }, select: { id: true, threadId: true } });
    if (!job?.threadId) return;
    const lastWrite: ThreadWriteResult = { kind: 'publish_failed', jobId: command.jobId, at: new Date().toISOString(), reason: detail.slice(0, 64) };
    await this.prisma.client.chatThread.update({ where: { id: job.threadId }, data: { lastWrite: lastWrite as unknown as Prisma.InputJsonValue } });
  }

  /** Clears the thread's `pendingQuestion` when the runner accepted an answer to that question (B2-D3). Caller holds the job lock. */
  private async clearAnsweredQuestion(jobId: string, requestId: string): Promise<void> {
    const job = await this.prisma.client.fleetJob.findUnique({ where: { id: jobId }, select: { id: true, threadId: true } });
    if (!job?.threadId) return;
    const thread = await this.prisma.client.chatThread.findUnique({ where: { id: job.threadId }, select: { pendingQuestion: true } });
    const question = thread?.pendingQuestion as { requestId?: unknown } | null | undefined;
    if (!question || question.requestId !== requestId) return;
    await this.prisma.client.chatThread.update({ where: { id: job.threadId }, data: { pendingQuestion: Prisma.DbNull } });
  }

  private async replaceCommandPayload(commandId: string, payload: unknown): Promise<void> {
    await this.prisma.client.fleetCommand.update({ where: { id: commandId }, data: { payload: payload as Prisma.InputJsonValue } });
  }
}
