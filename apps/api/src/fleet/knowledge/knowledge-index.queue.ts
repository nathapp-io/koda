import { Inject, Injectable, Logger } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { KnowledgeRepoIndexer } from './knowledge-repo-indexer';

/** 1c-c-D10: what asked for the pass. */
export type KnowledgeEnqueueReason = 'poll' | 'merge' | 'admin';

/** 1c-c-D10: the waiting set is capped so a poll storm cannot grow it without bound. */
export const KNOWLEDGE_QUEUE_MAX_WAITING = 1000;

/**
 * Fleet S5b (1c-c-D10): the in-process index queue.
 *
 * `enqueue` is synchronous and fire-and-forget: it never throws, so a trigger (poll, merge hook, admin
 * route) is never failed by indexing, and the caller cannot be blocked by a pass. One pass runs at a time
 * and a repository already waiting is not added twice, which is what keeps a merge that arrives while the
 * poll is draining from queueing the same repository again. A pass that fails — returned `failed` or thrown
 * — is logged and the next waiting id runs anyway.
 *
 * The queue does not survive an API restart; the next poll re-queues every repository (spec, US-005
 * out of scope).
 */
@Injectable()
export class KnowledgeIndexQueue {
  private readonly logger = new Logger(KnowledgeIndexQueue.name);
  /** Insertion-ordered, so `Set` iteration is the FIFO. */
  private readonly waiting = new Set<string>();
  private draining = false;

  constructor(
    private readonly indexer: KnowledgeRepoIndexer,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'knowledgeIndexEnabled'>,
  ) {}

  enqueue(repoId: string, reason: KnowledgeEnqueueReason): void {
    if (!this.config.knowledgeIndexEnabled) return; // kill switch: no queue, no pass (1c-c-D1)
    if (this.waiting.has(repoId)) return;
    if (this.waiting.size >= KNOWLEDGE_QUEUE_MAX_WAITING) {
      this.logger.warn(`Knowledge index queue is full; dropping ${reason} pass for repository ${repoId}`);
      return;
    }
    this.waiting.add(repoId);
    void this.drain();
  }

  /**
   * One pass at a time. Ids enqueued while a pass runs wait for it; the loop keeps a single drain alive
   * instead of starting a second one, so passes never overlap.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiting.size > 0) {
        const repoId = this.waiting.values().next().value;
        if (repoId === undefined) return;
        this.waiting.delete(repoId);
        await this.run(repoId);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Every failure stays here: the pass is logged and the drain continues. */
  private async run(repoId: string): Promise<void> {
    try {
      const result = await this.indexer.indexRepo(repoId);
      if (result.status === 'failed') {
        this.logger.warn(`Knowledge index pass failed for repository ${repoId}: ${result.reason ?? 'no reason'}`);
      }
    } catch (error) {
      this.logger.warn(`Knowledge index pass failed for repository ${repoId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
