import { Reflector } from '@nestjs/core';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { currentContext, type ActionContext } from '../../action-context/action-context';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { FleetLogRetentionProcessor, RETENTION_BATCH } from './fleet-log-retention.processor';

describe('FleetLogRetentionProcessor (S2a §5)', () => {
  const calls: string[] = [];
  const repo = {
    findCandidates: vi.fn(),
    findBundleKeys: vi.fn(async () => ['jobs/j1/1/a.tar.gz']),
    expireRows: vi.fn(async () => {
      calls.push('rows');
      return { events: 1, logs: 1, artifacts: 1 };
    }),
    /** US-009: the cleanup records a repository deletion captured before its cascade. */
    findRetiredCleanups: vi.fn(),
    deleteRetiredCleanup: vi.fn(async (id: string) => { calls.push(`ack:${id}`); }),
  };
  const jobs = { lockById: vi.fn(async (id: string): Promise<{ id: string } | null> => {
    calls.push(`lock:${id}`);
    return { id };
  }) };
  const tx = { run: vi.fn((fn: () => unknown) => fn()) };
  const logStore = { deletePrefix: vi.fn(async (p: string) => { calls.push(`rm:${p}`); }) };
  const artifacts = { delete: vi.fn(async (k: string) => { calls.push(`rm:${k}`); }) };
  const make = (days: number | null = 30) =>
    new FleetLogRetentionProcessor(repo as never, jobs as never, tx as never, logStore, artifacts, testFleetConfig({ logRetentionDays: days }), mockAuditRecorder);
  const candidate = (id: string, leaseEpoch = 1) => ({ id, leaseEpoch, finishedAt: new Date('2026-08-01T00:00:00.000Z') });
  /** US-009: one cleanup record a repository deletion captured before its cascade erased the job. */
  const retired = (jobId: string, over: { leaseEpoch?: number; bundleKeys?: string[] } = {}) => ({
    id: `c-${jobId}`,
    jobId,
    leaseEpoch: 1,
    finishedAt: new Date('2026-08-01T00:00:00.000Z'),
    bundleKeys: [`jobs/${jobId}/1/b.tar.gz`],
    ...over,
  });
  const before = new Date('2026-10-01T04:45:00.000Z');

  beforeEach(() => {
    // Neither pass has work unless a test says so.
    repo.findCandidates.mockResolvedValue([]);
    repo.findRetiredCleanups.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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
    vi.useFakeTimers().setSystemTime(new Date('2026-10-31T04:45:00.000Z'));
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

  /** Permissions P2 US-004: the cron method is the background entry; the purge runs as `log`. */
  it('AC-11: the nightly purge selects its candidates as SYSTEM/log', async () => {
    const seen: Array<ActionContext | undefined> = [];
    repo.findCandidates.mockImplementationOnce(async () => {
      seen.push(currentContext());
      return [];
    });

    await make(30).scheduledPurge();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'log' });
  });

  /**
   * US-009 (finding 5): a repository deletion hands the stored files of its terminal jobs to the
   * retention pass as cleanup records, so the pass drains them in the same nightly run — with the
   * same cutoff, the same batch bound and the same tolerate-and-retry rule as the live jobs.
   */
  describe('US-009 retired cleanup records', () => {
    it('US-009 AC-9: keeps the record pending when a later store deletion fails', async () => {
      repo.findRetiredCleanups.mockResolvedValueOnce([retired('j9')]);
      artifacts.delete.mockRejectedValueOnce(new Error('EACCES'));

      const out = await make().purge(before, new Date('2026-10-31T04:45:00.000Z'));

      expect(out).toEqual({ expired: 0, failed: 1 });
      // The unused cutoff is the pass's own, and the record's files were the ones targeted.
      expect(repo.findRetiredCleanups).toHaveBeenCalledWith(before, null, RETENTION_BATCH);
      expect(logStore.deletePrefix.mock.calls.map(([prefix]) => prefix)).toEqual(['logs/j9/0/', 'logs/j9/1/']);
      // Nothing is acknowledged and nothing is audited while a target may still be there.
      expect(repo.deleteRetiredCleanup).not.toHaveBeenCalled();
      expect(mockAuditRecorder.record).not.toHaveBeenCalled();
    });

    it('US-009 AC-10: completes the remaining work when the retry finds the first target already gone', async () => {
      repo.findRetiredCleanups.mockResolvedValueOnce([retired('j10')]).mockResolvedValueOnce([retired('j10')]);
      artifacts.delete.mockRejectedValueOnce(new Error('EACCES'));
      const worker = make();

      expect(await worker.purge(before, before)).toEqual({ expired: 0, failed: 1 });
      // The log prefix the first run already removed is deleted again (the store tolerates an absent
      // target) and the bundle that failed is the work the retry finishes.
      expect(await worker.purge(before, before)).toEqual({ expired: 1, failed: 0 });

      expect(logStore.deletePrefix.mock.calls.filter(([prefix]) => prefix === 'logs/j10/1/')).toHaveLength(2);
      expect(repo.deleteRetiredCleanup).toHaveBeenCalledExactlyOnceWith('c-j10');
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'system.log.retention', resourceType: 'fleet-job', resourceId: 'j10' }),
      );
    });

    it('US-009 AC-11: a third purge makes no further change once the record is acknowledged', async () => {
      repo.findRetiredCleanups.mockResolvedValueOnce([retired('j11')]).mockResolvedValueOnce([retired('j11')]);
      artifacts.delete.mockRejectedValueOnce(new Error('EACCES'));
      const worker = make();

      await worker.purge(before, before);
      await worker.purge(before, before);
      expect(repo.deleteRetiredCleanup).toHaveBeenCalledTimes(1);

      expect(await worker.purge(before, before)).toEqual({ expired: 0, failed: 0 });
      expect(repo.deleteRetiredCleanup).toHaveBeenCalledTimes(1);
      expect(logStore.deletePrefix).toHaveBeenCalledTimes(4);
    });

    it('US-009 AC-12: bounded purge still reaches later eligible records past a persistently failing target', async () => {
      const full = Array.from({ length: RETENTION_BATCH }, (_, i) => retired(`r${String(i).padStart(3, '0')}`));
      repo.findRetiredCleanups.mockResolvedValueOnce(full).mockResolvedValueOnce([retired('later')]);
      // The first record's bundle never deletes: it fails on every pass.
      artifacts.delete.mockImplementation(async (key: string) => {
        if (key === 'jobs/r000/1/b.tar.gz') throw new Error('EACCES');
      });

      const out = await make().purge(before, before);

      expect(out).toEqual({ expired: RETENTION_BATCH, failed: 1 });
      // The cursor is the last record of the page, never the last one that succeeded: a record that
      // keeps failing cannot pin the pass on the same page.
      expect(repo.findRetiredCleanups).toHaveBeenNthCalledWith(
        2, before, { finishedAt: full[RETENTION_BATCH - 1].finishedAt, id: full[RETENTION_BATCH - 1].id }, RETENTION_BATCH,
      );
      expect(repo.findRetiredCleanups).toHaveBeenCalledTimes(2);
      expect(repo.deleteRetiredCleanup).toHaveBeenCalledWith('c-later');
      expect(repo.deleteRetiredCleanup).not.toHaveBeenCalledWith('c-r000');
    });
  });
});
