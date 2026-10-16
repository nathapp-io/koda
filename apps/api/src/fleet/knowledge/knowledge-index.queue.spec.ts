/**
 * Fleet S5b US-005 — the index queue (1c-c-D10).
 *
 * The queue is an in-process FIFO with one pass in flight at a time, so every case here drives it with a
 * stubbed `KnowledgeRepoIndexer` and waits for the drain it starts (the queue itself is deliberately
 * fire-and-forget: `enqueue` never returns a promise and never throws).
 */
import { Logger } from '@nestjs/common';
import type { IFleetConfig } from '../../config/fleet.config';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import type { IndexPassResult } from './knowledge-repo-indexer';
import type { KnowledgeRepoIndexer } from './knowledge-repo-indexer';
import { KnowledgeIndexQueue } from './knowledge-index.queue';

interface Harness {
  queue: KnowledgeIndexQueue;
  indexer: { indexRepo: ReturnType<typeof vi.fn> };
  config: Pick<IFleetConfig, 'knowledgeIndexEnabled'>;
}

function harness(enabled = true): Harness {
  const indexer = { indexRepo: vi.fn(async (_repoId: string): Promise<IndexPassResult> => ({ status: 'indexed' })) };
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
