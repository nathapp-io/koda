/**
 * M10: each polling tick re-reads its connection by id, stops when the
 * connection is gone/inactive/not polling, stores the fetch cursor as
 * lastSyncedAt, and logs a capped fetch. A failing sync-log write never
 * escapes as an unhandled rejection (VCS LOW).
 */
import { SchedulerRegistry } from '@nestjs/schedule';
import { VcsPollingService } from './vcs-polling.service';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import type { VcsSyncService } from './vcs-sync.service';
import type { VcsPrSyncService } from './vcs-pr-sync.service';
import type { IVcsConfig } from '../config/vcs.config';

jest.mock('./factory', () => ({ createVcsProvider: jest.fn() }));
jest.mock('../common/utils/encryption.util', () => ({ decryptToken: jest.fn().mockReturnValue('plain') }));

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
  let repo: Record<string, jest.Mock>;
  let registry: { addInterval: jest.Mock; deleteInterval: jest.Mock };
  let fetchIssues: jest.Mock;
  let service: VcsPollingService;
  let unhandled: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    fetchIssues = jest.fn().mockResolvedValue({ issues: [], cursor: null, capped: false });
    (createVcsProvider as jest.Mock).mockReturnValue({ fetchIssues });
    repo = {
      findVcsConnectionById: jest.fn(),
      updateVcsConnectionLastSynced: jest.fn().mockResolvedValue(undefined),
      createVcsSyncLog: jest.fn().mockResolvedValue({}),
    };
    registry = { addInterval: jest.fn(), deleteInterval: jest.fn() };
    const sync = { filterByAllowedAuthors: jest.fn((issues) => issues), syncIssue: jest.fn() };
    const prSync = { syncPrStatus: jest.fn().mockResolvedValue({ updated: 0, skipped: 0 }) };
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
    jest.clearAllTimers();
    jest.useRealTimers();
    process.off('unhandledRejection', unhandled);
  });

  const tick = () => jest.advanceTimersByTimeAsync(INTERVAL);

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
});
