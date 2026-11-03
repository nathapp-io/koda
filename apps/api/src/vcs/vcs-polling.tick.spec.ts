import type { Mock } from 'vitest';
/**
 * M10: each polling tick re-reads its connection by id, stops when the
 * connection is gone/inactive/not polling, stores the fetch cursor as
 * lastSyncedAt, and logs a capped fetch. A failing sync-log write never
 * escapes as an unhandled rejection (VCS LOW).
 */
import { SchedulerRegistry } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';
import { VcsPollingService } from './vcs-polling.service';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import type { VcsSyncService } from './vcs-sync.service';
import type { VcsPrSyncService } from './vcs-pr-sync.service';
import type { IVcsConfig } from '../config/vcs.config';

vi.mock('./factory', () => ({ createVcsProvider: vi.fn() }));
vi.mock('../common/utils/encryption.util', () => ({ decryptToken: vi.fn().mockReturnValue('plain') }));

import { createVcsProvider } from './factory';

const INTERVAL = 60_000;

function connection(overrides: Partial<VcsConnectionWithProjectDomain> = {}): VcsConnectionWithProjectDomain {
  return {
    id: 'conn-1', projectId: 'proj-1', provider: 'github', repoOwner: 'o', repoName: 'r',
    encryptedToken: 'enc', syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: INTERVAL,
    webhookSecret: null, lastSyncedAt: null, isActive: true, createdAt: new Date(), updatedAt: new Date(),
    project: { id: 'proj-1', key: 'P', slug: 'p' },
    ...overrides,
  };
}

describe('VcsPollingService tick (M10)', () => {
  let repo: Record<string, Mock>;
  let registry: { addInterval: Mock; deleteInterval: Mock };
  let fetchIssues: Mock;
  let service: VcsPollingService;
  let unhandled: Mock;
  let sync: { filterByAllowedAuthors: Mock; syncIssue: Mock };
  let prSync: { syncPrStatus: Mock };
  const loggerError = vi.mocked(Logger.prototype.error);

  const issue = (number: number) => ({
    number, title: `Issue ${number}`, body: null, authorLogin: 'octo',
    url: `https://github.com/o/r/issues/${number}`, labels: [], createdAt: new Date(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    fetchIssues = vi.fn().mockResolvedValue({ issues: [], cursor: null, capped: false });
    (createVcsProvider as Mock).mockReturnValue({ fetchIssues });
    repo = {
      findVcsConnectionById: vi.fn(),
      updateVcsConnectionLastSynced: vi.fn().mockResolvedValue(undefined),
      createVcsSyncLog: vi.fn().mockResolvedValue({}),
    };
    registry = { addInterval: vi.fn(), deleteInterval: vi.fn() };
    sync = { filterByAllowedAuthors: vi.fn((issues) => issues), syncIssue: vi.fn().mockResolvedValue({ action: 'created' }) };
    prSync = { syncPrStatus: vi.fn().mockResolvedValue({ updated: 0, skipped: 0 }) };
    loggerError.mockClear();
    service = new VcsPollingService(
      repo as unknown as IVcsRepository,
      registry as unknown as SchedulerRegistry,
      sync as unknown as VcsSyncService,
      prSync as unknown as VcsPrSyncService,
      { encryptionKey: 'ab'.repeat(32), defaultPollingIntervalMs: INTERVAL, githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as IVcsConfig,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    process.off('unhandledRejection', unhandled);
  });

  const tick = () => vi.advanceTimersByTimeAsync(INTERVAL);

  /** Let the poll chain this tick started run to its next await (fake timers do not await it). */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  describe('Review P2 remainder (US-003): one poll per connection at a time', () => {
    let release: (() => void) | undefined;

    /** The next fetch never settles until the returned function is called. */
    const hangFetch = () => {
      fetchIssues.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ issues: [], cursor: null, capped: false });
          }),
      );
      return () => release?.();
    };

    afterEach(() => {
      release?.();
      release = undefined;
    });

    it('AC-10: a tick during an unsettled poll of the same connection does not poll it again', async () => {
      repo.findVcsConnectionById.mockResolvedValue(connection());
      const finishFirstPoll = hangFetch();
      service.schedulePolling(connection());

      await tick();
      await settle();
      expect(fetchIssues).toHaveBeenCalledTimes(1);

      // The previous poll of c1 never settled; this tick returns without re-reading the connection.
      await tick();
      await settle();

      expect(repo.findVcsConnectionById).toHaveBeenCalledTimes(1);
      finishFirstPoll();
      await settle();
    });

    it('AC-11: after a poll rejects, the next tick polls the same connection again', async () => {
      repo.findVcsConnectionById.mockResolvedValue(connection());
      fetchIssues
        .mockRejectedValueOnce(new Error('GitHub down'))
        .mockResolvedValue({ issues: [], cursor: null, capped: false });
      service.schedulePolling(connection());

      await tick();
      await settle();
      expect(fetchIssues).toHaveBeenCalledTimes(1);

      await tick();
      await settle();

      expect(fetchIssues).toHaveBeenCalledTimes(2);
      expect(repo.findVcsConnectionById).toHaveBeenCalledTimes(2);
    });

    it('AC-12: a tick for another connection still polls while c1 is in flight', async () => {
      repo.findVcsConnectionById.mockImplementation(async (id: string) =>
        id === 'conn-1' ? connection() : connection({ id: 'conn-2', projectId: 'proj-2', project: { id: 'proj-2', key: 'Q', slug: 'q' } }),
      );
      const finishFirstPoll = hangFetch();
      service.schedulePolling(connection());

      await tick();
      await settle();
      expect(fetchIssues).toHaveBeenCalledTimes(1);

      service.schedulePolling(connection({ id: 'conn-2', projectId: 'proj-2', project: { id: 'proj-2', key: 'Q', slug: 'q' } }));
      await tick();
      await settle();

      expect(repo.findVcsConnectionById).toHaveBeenCalledWith('conn-2');
      // c2 finished and wrote its sync log while c1's poll is still unsettled.
      expect(repo.createVcsSyncLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vcsConnectionId: 'conn-2' }));

      finishFirstPoll();
      await settle();
      expect(repo.createVcsSyncLog).toHaveBeenCalledWith(expect.objectContaining({ vcsConnectionId: 'conn-1' }));
    });
  });

  it('polls with the connection as it is now, not as it was scheduled', async () => {
    const cursor = new Date('2026-09-20T00:00:00Z');
    repo.findVcsConnectionById.mockResolvedValue(connection({ lastSyncedAt: cursor }));
    service.schedulePolling(connection());

    await tick();

    expect(repo.findVcsConnectionById).toHaveBeenCalledWith('conn-1');
    expect(fetchIssues).toHaveBeenCalledWith(cursor);
  });

  it.each([
    ['deleted', null],
    ['inactive', connection({ isActive: false })],
    ['switched to webhook', connection({ syncMode: 'webhook' })],
  ])('unschedules itself when the connection is %s', async (_label, current) => {
    repo.findVcsConnectionById.mockResolvedValue(current);
    service.schedulePolling(connection());

    await tick();

    expect(registry.deleteInterval).toHaveBeenLastCalledWith('vcs-polling-conn-1');
    expect(fetchIssues).not.toHaveBeenCalled();
  });

  it('stores the newest update seen as lastSyncedAt', async () => {
    const cursor = new Date('2026-09-21T10:00:00Z');
    repo.findVcsConnectionById.mockResolvedValue(connection());
    fetchIssues.mockResolvedValue({ issues: [], cursor, capped: false });
    service.schedulePolling(connection());

    await tick();

    expect(repo.updateVcsConnectionLastSynced).toHaveBeenCalledWith('conn-1', cursor);
    expect(repo.createVcsSyncLog).toHaveBeenCalledWith(expect.not.objectContaining({ errorMessage: expect.anything() }));
  });

  it('keeps the old cursor when nothing came back', async () => {
    repo.findVcsConnectionById.mockResolvedValue(connection());
    service.schedulePolling(connection());

    await tick();

    expect(repo.updateVcsConnectionLastSynced).not.toHaveBeenCalled();
  });

  it('writes a warning to the sync log when the fetch was capped', async () => {
    repo.findVcsConnectionById.mockResolvedValue(connection());
    fetchIssues.mockResolvedValue({ issues: [], cursor: new Date('2026-09-21T10:00:00Z'), capped: true });
    service.schedulePolling(connection());

    await tick();

    expect(repo.createVcsSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining('capped at 10 pages') }),
    );
  });

  it('survives a failed poll whose sync-log write also fails', async () => {
    repo.findVcsConnectionById.mockResolvedValue(connection());
    fetchIssues.mockRejectedValue(new Error('GitHub down'));
    repo.createVcsSyncLog.mockRejectedValue(new Error('DB down'));
    service.schedulePolling(connection());

    await tick();
    await tick();

    expect(repo.createVcsSyncLog).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('survives a failed re-read', async () => {
    repo.findVcsConnectionById.mockRejectedValue(new Error('DB down'));
    service.schedulePolling(connection());

    await tick();

    expect(unhandled).not.toHaveBeenCalled();
  });

  describe('Permissions P2 US-003: the poll entry point audit key', () => {
    it('passes system.vcs.poll-issues as the fourth syncPrStatus argument', async () => {
      repo.findVcsConnectionById.mockResolvedValue(connection());
      service.schedulePolling(connection());

      await tick();

      expect(prSync.syncPrStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'proj-1' }),
        expect.objectContaining({ id: 'conn-1' }),
        expect.any(String),
        'system.vcs.poll-issues',
      );
    });


    it('AC-20: passes system.vcs.poll-issues to syncIssue', async () => {
      const fetched = issue(11);
      repo.findVcsConnectionById.mockResolvedValue(connection());
      fetchIssues.mockResolvedValue({ issues: [fetched], cursor: null, capped: false });
      service.schedulePolling(connection());

      await tick();

      expect(sync.syncIssue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'proj-1' }),
        fetched,
        'polling',
        expect.objectContaining({ id: 'conn-1' }),
        'system.vcs.poll-issues',
      );
    });

    it('AC-30: an import that fails to record stops the batch at that issue', async () => {
      repo.findVcsConnectionById.mockResolvedValue(connection());
      fetchIssues.mockResolvedValue({ issues: [issue(1), issue(2)], cursor: null, capped: false });
      sync.syncIssue.mockRejectedValueOnce(new Error('audit down'));
      service.schedulePolling(connection());

      await tick();

      expect(sync.syncIssue).toHaveBeenCalledTimes(1);
      expect(sync.syncIssue).toHaveBeenCalledWith(
        expect.anything(), expect.objectContaining({ number: 1 }), 'polling', expect.anything(), 'system.vcs.poll-issues',
      );
    });

    it('AC-31/AC-32/AC-33: logs the failure, keeps the cursor and skips the PR sync', async () => {
      repo.findVcsConnectionById.mockResolvedValue(connection());
      fetchIssues.mockResolvedValue({
        issues: [issue(1)], cursor: new Date('2026-09-22T00:00:00Z'), capped: false,
      });
      sync.syncIssue.mockRejectedValueOnce(new Error('audit down'));
      service.schedulePolling(connection());

      await tick();

      const logged = loggerError.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('Polling failed for connection');
      expect(logged).toContain('conn-1');
      expect(logged).toContain('audit down');
      expect(repo.updateVcsConnectionLastSynced).not.toHaveBeenCalled();
      expect(prSync.syncPrStatus).not.toHaveBeenCalled();
    });
  });
});
