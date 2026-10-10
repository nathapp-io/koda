import { Inject, Injectable } from '@nestjs/common';
import { FleetCommandType } from '../../common/enums';
import { isThreadKind } from '../common/thread-jobs';
import { CHAT_THREAD_REPOSITORY, type ChatThreadRepository } from './domain/chat-thread.domain';
import type { FleetCommandRecord, FleetJobRecord } from '../jobs/domain/fleet-job.domain';

@Injectable()
export class ThreadJobEffects {
  constructor(@Inject(CHAT_THREAD_REPOSITORY) private readonly threads: ChatThreadRepository) {}

  async onInputAck(command: FleetCommandRecord, result: string, detail: string): Promise<void> {
    if (command.type !== FleetCommandType.THREAD_INPUT && command.type !== FleetCommandType.THREAD_ANSWER) return;
    await this.threads.applyInputAck(command, result, detail.slice(0, 200));
  }

  async onJobEnded(job: FleetJobRecord): Promise<void> {
    if (isThreadKind(job.command) && job.threadId) await this.threads.applyJobEnded(job);
  }

  archivedThreadIds(runnerId: string): Promise<string[]> {
    return this.threads.archivedThreadIds(runnerId);
  }
}
