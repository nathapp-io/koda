import { Reflector } from '@nestjs/core';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { FleetLogRetentionProcessor, RETENTION_BATCH } from './fleet-log-retention.processor';

describe('FleetLogRetentionProcessor (S2a §5)', () => {
  const calls: string[] = [];
  const repo = {
    findCandidates: jest.fn(),
    findBundleKeys: jest.fn(async () => ['jobs/j1/1/a.tar.gz']),
    expireRows: jest.fn(async () => {
      calls.push('rows');
      return { events: 1, logs: 1, artifacts: 1 };
    }),
  };
  const jobs = { lockById: jest.fn(async (id: string): Promise<{ id: string } | null> => {
    calls.push(`lock:${id}`);
    return { id };
  }) };
  const tx = { run: jest.fn((fn: () => unknown) => fn()) };
  const logStore = { deletePrefix: jest.fn(async (p: string) => { calls.push(`rm:${p}`); }) };
  const artifacts = { delete: jest.fn(async (k: string) => { calls.push(`rm:${k}`); }) };
  const make = (days: number | null = 30) =>
    new FleetLogRetentionProcessor(repo as never, jobs as never, tx as never, logStore, artifacts, testFleetConfig({ logRetentionDays: days }));
  const candidate = (id: string, leaseEpoch = 1) => ({ id, leaseEpoch, finishedAt: new Date('2026-08-01T00:00:00.000Z') });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    calls.length = 0;
  });

  it('runs daily at 04:45', () => {
    expect(new Reflector().get('SCHEDULE_CRON_OPTIONS', make().scheduledPurge)).toMatchObject({ cronTime: '45 4 * * *' });
  });

  it('does nothing when retention is disabled', async () => {
    await make(null).scheduledPurge();
    expect(repo.findCandidates).not.toHaveBeenCalled();
  });

  it('selects jobs that ended before now - days', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T04:45:00.000Z'));
    repo.findCandidates.mockResolvedValue([]);
    await make(30).scheduledPurge();
    expect(repo.findCandidates).toHaveBeenCalledWith(new Date('2026-10-01T04:45:00.000Z'), null, RETENTION_BATCH);
  });

  it('deletes files of every epoch <= E and the bundles first, then the rows under the job lock (D343, D344)', async () => {
    await make().expireJob(candidate('j1', 2), new Date(5));
    expect(calls).toEqual(['rm:logs/j1/0/', 'rm:logs/j1/1/', 'rm:logs/j1/2/', 'rm:jobs/j1/1/a.tar.gz', 'lock:j1', 'rows']);
    expect(repo.findBundleKeys).toHaveBeenCalledWith('j1', 2);
    expect(repo.expireRows).toHaveBeenCalledWith('j1', 2, new Date(5));
  });

  it('leaves the rows alone when the job row is gone', async () => {
    jobs.lockById.mockResolvedValueOnce(null);
    await make().expireJob(candidate('j1'), new Date(5));
    expect(repo.expireRows).not.toHaveBeenCalled();
  });

  it('pages by (finishedAt, id) until a short page and skips a failing job (D342)', async () => {
    const full = Array.from({ length: RETENTION_BATCH }, (_, i) => candidate(`a${String(i).padStart(3, '0')}`, 0));
    repo.findCandidates.mockResolvedValueOnce(full).mockResolvedValueOnce([candidate('b1', 0)]);
    logStore.deletePrefix.mockImplementationOnce(async () => { throw new Error('EACCES'); });
    const out = await make().purge(new Date(1), new Date(2));
    expect(out).toEqual({ expired: RETENTION_BATCH, failed: 1 });
    expect(repo.findCandidates).toHaveBeenNthCalledWith(2, new Date(1), { finishedAt: full[RETENTION_BATCH - 1].finishedAt, id: 'a199' }, RETENTION_BATCH);
    expect(repo.findCandidates).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed run (the next night is the retry)', async () => {
    repo.findCandidates.mockRejectedValueOnce(new Error('db down'));
    await expect(make().scheduledPurge()).resolves.toBeUndefined();
  });
});
