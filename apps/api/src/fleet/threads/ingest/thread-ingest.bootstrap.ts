import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runAsSystem } from '../../../action-context/action-context';
import { ThreadIngestor } from './thread-ingestor';
import { THREAD_UNFOLDED_STREAM_SOURCE, type UnfoldedStream, type UnfoldedStreamSource } from './domain/thread-ingest.domain';

/**
 * S5a startup catch-up: a failed fold on a stream's last append is otherwise never retried. Every stream that is
 * still unfolded is caught up in order, and one failure is logged without stopping the rest.
 */
@Injectable()
export class ThreadIngestBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(ThreadIngestBootstrap.name);

  constructor(
    @Inject(THREAD_UNFOLDED_STREAM_SOURCE) private readonly source: UnfoldedStreamSource,
    private readonly ingestor: ThreadIngestor,
  ) {}

  /**
   * Permissions P2 US-005: the boot hook is the background entry, so the catch-up folds as `thread`. A fold
   * triggered by a runner's log upload keeps that upload's `RUNNER` context (`ThreadIngestHook` is not wrapped).
   */
  async onApplicationBootstrap(): Promise<void> {
    await runAsSystem('thread', () => this.catchUpUnfoldedStreams());
  }

  private async catchUpUnfoldedStreams(): Promise<void> {
    let candidates: UnfoldedStream[];
    try {
      candidates = await this.source.findUnfolded();
    } catch (error) {
      this.logger.error('Startup catch-up could not list unfolded thread streams', error);
      return;
    }
    for (const { jobId, leaseEpoch } of candidates) {
      try {
        await this.ingestor.catchUp(jobId, leaseEpoch);
      } catch (error) {
        this.logger.error(`Startup catch-up failed for thread job ${jobId} epoch ${leaseEpoch}`, error);
      }
    }
  }
}
