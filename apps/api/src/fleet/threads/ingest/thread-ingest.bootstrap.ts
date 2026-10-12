import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ThreadIngestor } from './thread-ingestor';

export const THREAD_UNFOLDED_STREAM_SOURCE: unique symbol = Symbol('THREAD_UNFOLDED_STREAM_SOURCE');

/** One THREAD job attempt whose `thread` stream holds bytes past its fold cursor. */
export interface UnfoldedStream {
  jobId: string;
  leaseEpoch: number;
}

export interface UnfoldedStreamSource {
  /** Attempts still to fold: non-terminal or finished within 24 hours, at most 200, oldest job first. */
  findUnfolded(): Promise<UnfoldedStream[]>;
}

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

  async onApplicationBootstrap(): Promise<void> {
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
