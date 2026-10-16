import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { KnowledgeRepoIndexer } from './knowledge-repo-indexer';
import {
  KNOWLEDGE_REPO_MERGED,
  KNOWLEDGE_RUN_INGESTED,
  type KnowledgeRepoMergedEvent,
  type KnowledgeRunIngestedEvent,
} from '../common/knowledge-events';

/** 1c-c-D10: what asked for the pass. */
export type KnowledgeEnqueueReason = 'poll' | 'merge' | 'admin';

/** 1c-c-D10: the waiting set is capped so a poll storm cannot grow it without bound. */
export const KNOWLEDGE_QUEUE_MAX_WAITING = 1000;

/** S5b 3c-2-D8: an outcome pass waits under this key, which tells the drain to call `indexOutcomes`. */
export const KNOWLEDGE_OUTCOME_KEY_PREFIX = 'job:';

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
 *
 * S5b 3c-2-D8 (US-004): an outcome pass shares that queue — the same waiting set, the same cap, the same
 * kill switch — under a `job:<jobId>` key. Nothing coordinates it across API instances, and it records no
 * state, so a dropped or failed pass is only recovered by the next ingest re-run.
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
    this.add(repoId, `repository ${repoId}`, reason);
  }

  /** The merge hook (`FleetPrStateRefresher`) emits this; the queue is its only listener (1c-c-D11). */
  @OnEvent(KNOWLEDGE_REPO_MERGED)
  onRepoMerged(event: KnowledgeRepoMergedEvent): void {
    this.enqueue(event.repoId, 'merge');
  }

  /** The bundle ingest emits this after a RUN's ingest commits (3c-2-D8). */
  @OnEvent(KNOWLEDGE_RUN_INGESTED)
  onRunIngested(event: KnowledgeRunIngestedEvent): void {
    this.enqueueOutcomes(event.jobId);
  }

  /** S5b 3c-2-D8: one outcome pass for a job, deduplicated and capped like a repository id. */
  enqueueOutcomes(jobId: string): void {
    this.add(`${KNOWLEDGE_OUTCOME_KEY_PREFIX}${jobId}`, `job ${jobId}`, 'outcome');
  }

  private add(key: string, label: string, reason: string): void {
    if (!this.config.knowledgeIndexEnabled) return; // kill switch: no queue, no pass (1c-c-D1)
    if (this.waiting.has(key)) return;
    if (this.waiting.size >= KNOWLEDGE_QUEUE_MAX_WAITING) {
      this.logger.warn(`Knowledge index queue is full; dropping ${reason} pass for ${label}`);
      return;
    }
    this.waiting.add(key);
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
        const key = this.waiting.values().next().value;
        if (key === undefined) return;
        this.waiting.delete(key);
        await this.run(key);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Every failure stays here: the pass is logged and the drain continues. */
  private async run(key: string): Promise<void> {
    const jobId = key.startsWith(KNOWLEDGE_OUTCOME_KEY_PREFIX) ? key.slice(KNOWLEDGE_OUTCOME_KEY_PREFIX.length) : null;
    const label = jobId === null ? `repository ${key}` : `job ${jobId}`;
    try {
      const result = jobId === null ? await this.indexer.indexRepo(key) : await this.indexer.indexOutcomes(jobId);
      if (result.status === 'failed') this.logger.warn(`Knowledge index pass failed for ${label}: ${result.reason ?? 'no reason'}`);
    } catch (error) {
      this.logger.warn(`Knowledge index pass failed for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
