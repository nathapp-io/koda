import { Logger } from '@nestjs/common';
import { ThreadIngestBootstrap, type UnfoldedStream, type UnfoldedStreamSource } from './thread-ingest.bootstrap';
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
});
