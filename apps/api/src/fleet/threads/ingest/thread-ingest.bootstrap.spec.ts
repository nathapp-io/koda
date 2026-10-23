import { Logger } from '@nestjs/common';
import { currentContext, type ActionContext } from '../../../action-context/action-context';
import { ThreadIngestBootstrap } from './thread-ingest.bootstrap';
import type { UnfoldedStream, UnfoldedStreamSource } from './domain/thread-ingest.domain';
import type { ThreadIngestor } from './thread-ingestor';

describe('ThreadIngestBootstrap (US-007)', () => {
  const streams: UnfoldedStream[] = [
    { jobId: 'J1', leaseEpoch: 1 },
    { jobId: 'J2', leaseEpoch: 1 },
  ];

  const build = (overrides: { source?: Partial<UnfoldedStreamSource>; catchUp?: ThreadIngestor['catchUp'] } = {}) => {
    const source: UnfoldedStreamSource = {
      findUnfolded: vi.fn(async () => streams),
      ...overrides.source,
    };
    const ingestor = { catchUp: vi.fn(overrides.catchUp ?? (async () => undefined)) };
    const bootstrap = new ThreadIngestBootstrap(source, ingestor as unknown as ThreadIngestor);
    return { bootstrap, source, ingestor };
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('US-007: catches up each unfolded stream in the order the source returns them', async () => {
    const { bootstrap, ingestor } = build();
    await bootstrap.onApplicationBootstrap();
    expect(ingestor.catchUp.mock.calls).toEqual([['J1', 1], ['J2', 1]]);
  });

  it('US-007: a catchUp that rejects is logged and the next stream is still caught up', async () => {
    const failure = new Error('fold failed');
    const { bootstrap, ingestor } = build({
      catchUp: vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined) as unknown as ThreadIngestor['catchUp'],
    });
    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(ingestor.catchUp).toHaveBeenNthCalledWith(2, 'J2', 1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('J1'), failure);
  });

  it('US-007: a failing candidate query is logged and resolves boot without a catchUp call', async () => {
    const failure = new Error('db down');
    const { bootstrap, ingestor } = build({ source: { findUnfolded: vi.fn(async () => { throw failure; }) } });
    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(ingestor.catchUp).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('could not list'), failure);
  });

  it('US-007: a source with no unfolded streams makes no catchUp call', async () => {
    const { bootstrap, ingestor } = build({ source: { findUnfolded: vi.fn(async () => []) } });
    await bootstrap.onApplicationBootstrap();
    expect(ingestor.catchUp).not.toHaveBeenCalled();
  });

  /** Permissions P2 US-005: the boot hook is the background entry; the catch-up folds as `thread`. */
  it('AC-10: the boot catch-up folds each unfolded stream as SYSTEM/thread', async () => {
    const seen: Array<ActionContext | undefined> = [];
    const { bootstrap } = build({
      catchUp: vi.fn(async () => {
        seen.push(currentContext());
      }) as unknown as ThreadIngestor['catchUp'],
      source: { findUnfolded: vi.fn(async () => [{ jobId: 'J1', leaseEpoch: 1 }]) },
    });

    await bootstrap.onApplicationBootstrap();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'thread' });
  });
});
