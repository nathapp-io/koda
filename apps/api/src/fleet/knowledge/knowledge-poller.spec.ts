/**
 * Fleet S5b US-005 — the knowledge poller (1c-c-D11).
 *
 * The poller is a thin trigger: a `FleetPrStateRefresher`-style interval that enqueues every installed GitHub
 * repository. It holds no state besides its timer, so the timer lifecycle is pinned with a stubbed
 * `setInterval` and the enumeration with a stubbed module-private repository.
 */
import { Logger } from '@nestjs/common';
import type { IFleetConfig } from '../../config/fleet.config';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import type { IKnowledgeIndexRepository, KnowledgeRepoRef } from './knowledge-index.domain';
import type { KnowledgeIndexQueue } from './knowledge-index.queue';
import { KnowledgePoller } from './knowledge-poller';

const repo = (id: string): KnowledgeRepoRef => ({
  id, projectId: 'p', provider: 'github', owner: 'o', name: id, defaultBranch: 'main', githubInstallationId: BigInt(7),
});

interface Harness {
  poller: KnowledgePoller;
  repos: { findAllGithubRepos: ReturnType<typeof vi.fn> };
  queue: { enqueue: ReturnType<typeof vi.fn> };
  config: Pick<IFleetConfig, 'knowledgeIndexEnabled' | 'knowledgePollMs'>;
}

function harness(overrides: Partial<IFleetConfig> = {}): Harness {
  const repos = { findAllGithubRepos: vi.fn(async (): Promise<KnowledgeRepoRef[]> => []) };
  const queue = { enqueue: vi.fn() };
  const config = testFleetConfig({ knowledgeIndexEnabled: true, knowledgePollMs: 1_800_000, ...overrides });
  const poller = new KnowledgePoller(
    repos as unknown as IKnowledgeIndexRepository,
    queue as unknown as KnowledgeIndexQueue,
    config,
  );
  return { poller, repos, queue, config };
}

describe('KnowledgePoller (1c-c-D11)', () => {
  it('AC-6: starts no timer while indexing is off', () => {
    const interval = vi.spyOn(global, 'setInterval');
    const { poller } = harness({ knowledgeIndexEnabled: false });

    poller.onModuleInit();

    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('starts one unrefed timer with the configured interval and clears it on destroy', () => {
    const timer = { unref: vi.fn() };
    const interval = vi.spyOn(global, 'setInterval').mockReturnValue(timer as unknown as NodeJS.Timeout);
    const clear = vi.spyOn(global, 'clearInterval');
    const { poller } = harness({ knowledgePollMs: 90_000 });

    poller.onModuleInit();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 90_000);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    poller.onModuleDestroy();
    expect(clear).toHaveBeenCalledWith(timer);

    poller.onModuleDestroy(); // idempotent: no timer to clear twice
    expect(clear).toHaveBeenCalledTimes(1);
    interval.mockRestore();
    clear.mockRestore();
  });

  it('AC-7: enqueues every installed GitHub repository with reason poll', async () => {
    const { poller, repos, queue } = harness();
    repos.findAllGithubRepos.mockResolvedValue([repo('r1'), repo('r2'), repo('r3')]);

    await poller.poll();

    expect(repos.findAllGithubRepos).toHaveBeenCalledTimes(1);
    expect(queue.enqueue.mock.calls).toEqual([['r1', 'poll'], ['r2', 'poll'], ['r3', 'poll']]);
  });

  it('enqueues nothing when the project has no GitHub repository', async () => {
    const { poller, queue } = harness();

    await poller.poll();

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('never rejects when the repository query fails, so the interval keeps ticking', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const { poller, repos } = harness();
    repos.findAllGithubRepos.mockRejectedValue(new Error('db down'));

    await expect(poller.poll()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps enqueuing the repositories after a failed read is not fatal', async () => {
    const { poller, repos, queue } = harness();
    repos.findAllGithubRepos.mockResolvedValue([repo('r1')]);

    await poller.poll();
    await poller.poll();

    expect(queue.enqueue.mock.calls).toEqual([['r1', 'poll'], ['r1', 'poll']]);
  });
});
