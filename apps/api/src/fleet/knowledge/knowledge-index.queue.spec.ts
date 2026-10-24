/**
 * Fleet S5b US-005 — the index queue (1c-c-D10).
 *
 * The queue is an in-process FIFO with one pass in flight at a time, so every case here drives it with a
 * stubbed `KnowledgeRepoIndexer` and waits for the drain it starts (the queue itself is deliberately
 * fire-and-forget: `enqueue` never returns a promise and never throws).
 */
import { Logger } from '@nestjs/common';
import { currentContext, runWithActionContext, type ActionContext } from '../../action-context/action-context';
import type { IFleetConfig } from '../../config/fleet.config';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import type { IndexPassResult, OutcomePassResult } from './knowledge-repo-indexer';
import type { KnowledgeRepoIndexer } from './knowledge-repo-indexer';
import { KnowledgeIndexQueue } from './knowledge-index.queue';

interface Harness {
  queue: KnowledgeIndexQueue;
  indexer: { indexRepo: ReturnType<typeof vi.fn>; indexOutcomes: ReturnType<typeof vi.fn> };
  config: Pick<IFleetConfig, 'knowledgeIndexEnabled'>;
}

function harness(enabled = true): Harness {
  const indexer = {
    indexRepo: vi.fn(async (_repoId: string): Promise<IndexPassResult> => ({ status: 'indexed' })),
    indexOutcomes: vi.fn(async (_jobId: string): Promise<OutcomePassResult> => ({ status: 'indexed' })),
  };
  const config = testFleetConfig({ knowledgeIndexEnabled: enabled });
  // Direct instantiation: the queue has no Nest lifecycle, only constructor dependencies (api-testing rule).
  const queue = new KnowledgeIndexQueue(indexer as unknown as KnowledgeRepoIndexer, config);
  return { queue, indexer, config };
}

/** The ids the stub was actually asked to index, in call order. */
const ids = (indexer: Harness['indexer']): string[] => indexer.indexRepo.mock.calls.map((call) => call[0] as string);

describe('KnowledgeIndexQueue (1c-c-D10)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // test-setup.ts already installs the no-op logger spy; this returns the same spy so counts are exact.
    warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
  });

  it('AC-1: indexes the enqueued repository once', async () => {
    const { queue, indexer } = harness();

    queue.enqueue('r1', 'admin');

    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    expect(indexer.indexRepo).toHaveBeenCalledWith('r1');
  });

  it('AC-2: drains one pass at a time, in order, and never doubles a waiting id', async () => {
    const { queue, indexer } = harness();
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementationOnce(() => new Promise<IndexPassResult>((resolve) => { release = resolve; }));

    queue.enqueue('r0', 'admin');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));

    queue.enqueue('r1', 'poll');
    queue.enqueue('r2', 'poll');
    queue.enqueue('r1', 'poll');

    // r0 still holds the single pass slot: nothing else started while it runs.
    expect(ids(indexer)).toEqual(['r0']);
    release({ status: 'indexed' });

    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(3));
    expect(ids(indexer)).toEqual(['r0', 'r1', 'r2']);
  });

  it('AC-3: does nothing while indexing is off', async () => {
    const { queue, indexer } = harness(false);

    queue.enqueue('r1', 'admin');
    queue.enqueue('r2', 'poll');
    await new Promise((resolve) => setImmediate(resolve));

    expect(indexer.indexRepo).not.toHaveBeenCalled();
  });

  it('AC-4: a rejected pass warns once, keeps the queue alive and never reaches the caller', async () => {
    const { queue, indexer } = harness();
    indexer.indexRepo.mockRejectedValueOnce(new Error('github is down'));

    expect(() => queue.enqueue('r1', 'admin')).not.toThrow();
    queue.enqueue('r2', 'poll');

    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(indexer.indexRepo.mock.calls[1][0]).toBe('r2');
  });

  it('warns once for a pass that resolves failed, and enqueues nothing itself', async () => {
    const { queue, indexer } = harness();
    indexer.indexRepo.mockResolvedValueOnce({ status: 'failed', reason: 'unknown repo' });

    queue.enqueue('r1', 'admin');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toContain('unknown repo');
    expect(indexer.indexRepo).toHaveBeenCalledTimes(1);
  });

  it('logs nothing for a healthy pass', async () => {
    const { queue, indexer } = harness();

    queue.enqueue('r1', 'merge');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).not.toHaveBeenCalled();
  });

  it('AC-5: drops a new id with a warning once 1000 ids are waiting', async () => {
    const { queue, indexer } = harness();
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementationOnce(() => new Promise<IndexPassResult>((resolve) => { release = resolve; }));

    queue.enqueue('r0', 'poll');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    for (let index = 1; index <= 1000; index += 1) queue.enqueue(`r${index}`, 'poll');

    warn.mockClear();
    queue.enqueue('overflow', 'admin');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('overflow');

    release({ status: 'indexed' });
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1001));
    expect(ids(indexer)).not.toContain('overflow');
  });

  it('accepts a new id again once the waiting set has drained below the cap', async () => {
    const { queue, indexer } = harness();
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementationOnce(() => new Promise<IndexPassResult>((resolve) => { release = resolve; }));

    queue.enqueue('r0', 'poll');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    for (let index = 1; index <= 1000; index += 1) queue.enqueue(`r${index}`, 'poll');
    queue.enqueue('late', 'admin'); // dropped: the waiting set is full

    release({ status: 'indexed' });
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1001));
    queue.enqueue('late', 'admin'); // the cap is a queue-full rule, not a latch

    await vi.waitFor(() => expect(ids(indexer)).toContain('late'));
  });

  it('deduplicates a run of poll triggers for one repository', async () => {
    const { queue, indexer } = harness();
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementationOnce(() => new Promise<IndexPassResult>((resolve) => { release = resolve; }));

    queue.enqueue('r0', 'poll');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    for (let trigger = 0; trigger < 50; trigger += 1) queue.enqueue('r1', 'poll');

    release({ status: 'indexed' });
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(2));
    expect(ids(indexer)).toEqual(['r0', 'r1']);
  });
});

/**
 * Fleet S5b US-004 (3c-2-D8): outcome passes share the repository queue — one FIFO, one pass at a time,
 * the same waiting set, the same cap and the same kill switch. A `job:` key reaches `indexOutcomes`, any
 * other key reaches `indexRepo`.
 */
describe('KnowledgeIndexQueue outcome keys (S5b US-004)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
  });

  it('AC-11: runs indexOutcomes once for a job enqueued twice while a repository pass runs', async () => {
    const { queue, indexer } = harness();
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementationOnce(() => new Promise<IndexPassResult>((resolve) => { release = resolve; }));

    queue.enqueue('r1', 'admin');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));

    queue.enqueueOutcomes('j1');
    queue.enqueueOutcomes('j1');

    // r1 still holds the single pass slot: the outcome pass waits for it and never overlaps.
    expect(indexer.indexOutcomes).not.toHaveBeenCalled();
    release({ status: 'indexed' });

    await vi.waitFor(() => expect(indexer.indexOutcomes).toHaveBeenCalledTimes(1));
    expect(indexer.indexOutcomes).toHaveBeenCalledWith('j1');
    expect(indexer.indexRepo).toHaveBeenCalledTimes(1);
  });

  it('AC-12: enqueueing an outcome pass does nothing while indexing is off', async () => {
    const { queue, indexer } = harness(false);

    queue.enqueueOutcomes('j1');
    queue.enqueueOutcomes('j2');
    await new Promise((resolve) => setImmediate(resolve));

    expect(indexer.indexOutcomes).not.toHaveBeenCalled();
    expect(indexer.indexRepo).not.toHaveBeenCalled();
  });

  it('AC-13: a failed outcome pass warns with the job and the reason and keeps draining', async () => {
    const { queue, indexer } = harness();
    indexer.indexOutcomes.mockResolvedValueOnce({ status: 'failed', reason: 'boom' });

    queue.enqueueOutcomes('j1');
    queue.enqueue('r2', 'poll');

    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    expect(indexer.indexOutcomes).toHaveBeenCalledTimes(1);
    expect(indexer.indexRepo).toHaveBeenCalledWith('r2');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('j1');
    expect(String(warn.mock.calls[0][0])).toContain('boom');
  });

  it('AC-13: a rejected outcome pass warns and keeps draining', async () => {
    const { queue, indexer } = harness();
    indexer.indexOutcomes.mockRejectedValueOnce(new Error('lancedb is down'));

    expect(() => queue.enqueueOutcomes('j1')).not.toThrow();
    queue.enqueueOutcomes('j2');

    await vi.waitFor(() => expect(indexer.indexOutcomes).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('lancedb is down');
    expect(indexer.indexOutcomes.mock.calls).toEqual([['j1'], ['j2']]);
  });

  it('logs nothing for a skipped or healthy outcome pass', async () => {
    const { queue, indexer } = harness();
    indexer.indexOutcomes.mockResolvedValueOnce({ status: 'skipped', reason: 'unknown job' });

    queue.enqueueOutcomes('j1');

    await vi.waitFor(() => expect(indexer.indexOutcomes).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).not.toHaveBeenCalled();
  });

  it('drains job keys and repository ids through one FIFO, one pass at a time', async () => {
    const { queue, indexer } = harness();
    const order: string[] = [];
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementation(async (repoId: string) => {
      order.push(`repo:${repoId}`);
      return { status: 'indexed' };
    });
    indexer.indexOutcomes.mockImplementation(async (jobId: string) => {
      order.push(`job:${jobId}`);
      if (jobId === 'j1') await new Promise<void>((resolve) => { release = () => resolve(); });
      return { status: 'indexed' };
    });

    queue.enqueue('r1', 'poll');
    queue.enqueueOutcomes('j1');
    await vi.waitFor(() => expect(order).toEqual(['repo:r1', 'job:j1']));

    queue.enqueue('r2', 'poll');
    queue.enqueueOutcomes('j2');
    expect(order).toEqual(['repo:r1', 'job:j1']); // j1 holds the slot: nothing else started

    release({ status: 'indexed' });
    await vi.waitFor(() => expect(order).toEqual(['repo:r1', 'job:j1', 'repo:r2', 'job:j2']));
  });

  it('drops an outcome key with a warning once 1000 keys are waiting', async () => {
    const { queue, indexer } = harness();
    let release: (result: IndexPassResult) => void = () => undefined;
    indexer.indexRepo.mockImplementationOnce(() => new Promise<IndexPassResult>((resolve) => { release = resolve; }));

    queue.enqueue('r0', 'poll');
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1));
    for (let index = 1; index <= 1000; index += 1) queue.enqueue(`r${index}`, 'poll');

    warn.mockClear();
    queue.enqueueOutcomes('overflow');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('overflow');

    release({ status: 'indexed' });
    await vi.waitFor(() => expect(indexer.indexRepo).toHaveBeenCalledTimes(1001));
    expect(indexer.indexOutcomes).not.toHaveBeenCalled();
  });
});

/**
 * The trigger events (`common/knowledge-events.ts`): the merge hook and the ingest emit, the queue listens, so
 * neither emitter's module imports `KnowledgeModule`. The handlers only translate the payload into the same
 * enqueue calls the emitters used to make.
 */
describe('KnowledgeIndexQueue trigger events', () => {
  it('a repo-merged event enqueues a merge pass for that repository', () => {
    const { queue } = harness();
    const enqueue = vi.spyOn(queue, 'enqueue');

    queue.onRepoMerged({ repoId: 'r9' });

    expect(enqueue).toHaveBeenCalledExactlyOnceWith('r9', 'merge');
  });

  it('a run-ingested event enqueues one outcome pass for that job', () => {
    const { queue } = harness();
    const enqueueOutcomes = vi.spyOn(queue, 'enqueueOutcomes');

    queue.onRunIngested({ jobId: 'j1' });

    expect(enqueueOutcomes).toHaveBeenCalledExactlyOnceWith('j1');
  });

  it('the handlers keep the kill switch: no pass while indexing is off', async () => {
    const { queue, indexer } = harness(false);

    queue.onRepoMerged({ repoId: 'r9' });
    queue.onRunIngested({ jobId: 'j1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(indexer.indexRepo).not.toHaveBeenCalled();
    expect(indexer.indexOutcomes).not.toHaveBeenCalled();
  });
});

/**
 * Permissions P2 US-004: a drain always runs as the `knowledge` component, whoever enqueued it, and takes a
 * correlation id of its own — the first enqueuer's request must not leak into later passes.
 */
describe('KnowledgeIndexQueue system context (US-004)', () => {
  /** Builds an enabled queue whose indexer records the context the pass ran in, then runs `trigger`. */
  const passContextFor = async (trigger: (queue: KnowledgeIndexQueue) => void): Promise<ActionContext> => {
    const { queue, indexer } = harness(true);
    const seen: Array<ActionContext | undefined> = [];
    indexer.indexRepo.mockImplementation(async () => {
      seen.push(currentContext());
      return { status: 'indexed' };
    });

    trigger(queue);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    return seen[0] as ActionContext;
  };

  it('AC-12: a repo-merged trigger outside any context indexes as SYSTEM/knowledge', async () => {
    const context = await passContextFor((queue) => queue.onRepoMerged({ repoId: 'r9' }));

    expect(context.actor).toEqual({ type: 'SYSTEM', id: 'knowledge' });
  });

  it('AC-13: an enqueue inside a USER/u1 context indexes as SYSTEM/knowledge, not as the enqueuer', async () => {
    const context = await runWithActionContext(
      { actor: { type: 'USER', id: 'u1' }, origin: 'rest', correlationId: 'c-request' },
      () => passContextFor((queue) => queue.enqueue('r9', 'admin')),
    );

    expect(context.actor).toEqual({ type: 'SYSTEM', id: 'knowledge' });
  });

  it('a drain takes a correlation id of its own instead of the first enqueuer\'s', async () => {
    const context = await runWithActionContext(
      { actor: { type: 'USER', id: 'u1' }, origin: 'rest', correlationId: 'c-request' },
      () => passContextFor((queue) => queue.enqueue('r9', 'admin')),
    );

    expect(context.correlationId).not.toBe('c-request');
    expect(context.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
