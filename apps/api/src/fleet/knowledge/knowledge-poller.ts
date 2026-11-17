import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IKnowledgeIndexRepository, KNOWLEDGE_INDEX_REPOSITORY } from './knowledge-index.domain';
import { KnowledgeIndexQueue } from './knowledge-index.queue';

/**
 * Fleet S5b (1c-c-D11): the freshness timer.
 *
 * In process (one API instance), the `FleetPrStateRefresher` pattern: an unrefed interval that enqueues every
 * installed GitHub repository, started only when the kill switch is on. It is deliberately the only poller —
 * there is no GitHub push webhook in this story — and it reads repositories through the module-private state
 * repository, so `KnowledgeIndexService` stays the only face other modules see.
 */
@Injectable()
@SystemWriter('system.knowledge.poll')
export class KnowledgePoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgePoller.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(KNOWLEDGE_INDEX_REPOSITORY) private readonly repos: IKnowledgeIndexRepository,
    private readonly queue: KnowledgeIndexQueue,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'knowledgeIndexEnabled' | 'knowledgePollMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.config.knowledgeIndexEnabled) return; // kill switch: no timer at all (1c-c-D1)
    this.timer = setInterval(() => void this.poll(), this.config.knowledgePollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Never rejects: a failed read must not kill the interval (the `void`ed call would be unhandled otherwise).
   * US-004: the two sources are read and enqueued one after the other, each under its own `try`, so one
   * failing read still queues the other's repositories.
   */
  async poll(): Promise<void> {
    for (const [label, read] of [
      ['GitHub', () => this.repos.findAllGithubRepos()],
      ['GitLab', () => this.repos.findAllGitlabRepos()],
    ] as const) {
      try {
        for (const repo of await read()) this.queue.enqueue(repo.id, 'poll');
      } catch (error) {
        this.logger.warn(`Knowledge poll of ${label} repositories failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
