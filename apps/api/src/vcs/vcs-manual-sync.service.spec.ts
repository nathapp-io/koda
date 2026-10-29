import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { VcsManualSync } from './vcs-manual-sync.service';
import type { ProjectsService } from '../projects/projects.service';
import type { VcsConnectionService } from './vcs-connection.service';
import type { VcsPrSyncService } from './vcs-pr-sync.service';
import type { VcsSyncService } from './vcs-sync.service';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import type { IVcsConfig } from '../config/vcs.config';

const provider = vi.hoisted(() => ({ fetchIssues: vi.fn(), fetchIssue: vi.fn() }));
vi.mock('./provider-for-connection', () => ({ providerForConnection: vi.fn(() => provider) }));
vi.mock('../common/utils/encryption.util', () => ({ decryptToken: vi.fn(() => 'plain') }));

describe('VcsManualSync', () => {
  const issue = { number: 7, title: 'Issue seven', body: null, authorLogin: 'alice', url: 'https://github.com/acme/repo/issues/7', labels: [], createdAt: new Date() };
  let connection: VcsConnectionDomain;
  let sync: { syncIssues: ReturnType<typeof vi.fn>; syncIssue: ReturnType<typeof vi.fn>; fullSync: ReturnType<typeof vi.fn>; filterByAllowedAuthors: ReturnType<typeof vi.fn> };
  let service: VcsManualSync;
  const prSync = { syncPrStatus: vi.fn(), fetchPrStatuses: vi.fn(), applyPrStatuses: vi.fn(), startExtractions: vi.fn() };
  let connections: { getFullByProject: ReturnType<typeof vi.fn> };
  let config: IVcsConfig;
  beforeEach(() => {
    vi.resetAllMocks();
    prSync.fetchPrStatuses.mockResolvedValue([]);
    prSync.applyPrStatuses.mockResolvedValue({ updated: 1, skipped: 0, extractions: [] });
    prSync.syncPrStatus.mockResolvedValue({ updated: 1, skipped: 0 });
    connection = { id: 'c', projectId: 'p', provider: 'github', repoOwner: 'acme', repoName: 'repo', encryptedToken: 'enc', allowedAuthors: '[]', syncMode: 'off', pollingIntervalMs: 300000, webhookSecret: null, lastSyncedAt: null, isActive: true, createdAt: new Date(), updatedAt: new Date() };
    provider.fetchIssues.mockResolvedValue({ issues: [issue] });
    provider.fetchIssue.mockResolvedValue(issue);
    sync = { syncIssues: vi.fn().mockResolvedValue({ issuesSynced: 1, issuesSkipped: 0, createdTickets: [{ number: 3, title: issue.title }], errors: [] }), syncIssue: vi.fn().mockResolvedValue({ action: 'created', ticketNumber: 3 }), fullSync: vi.fn(), filterByAllowedAuthors: vi.fn((issues) => issues) };
    connections = { getFullByProject: vi.fn(async () => ({ ...connection })) };
    config = { encryptionKey: 'key' } as IVcsConfig;
    service = new VcsManualSync(
      { findBySlug: vi.fn().mockResolvedValue({ id: 'p', key: 'ALPHA' }) } as unknown as ProjectsService,
      connections as unknown as VcsConnectionService,
      sync as unknown as VcsSyncService,
      config,
      prSync as unknown as VcsPrSyncService,
    );
  });
  it('PR prepare fetches before strict apply and leaves extraction to afterCommit', async () => {
    const apply = await service.prepareSyncPr('alpha');
    expect(prSync.fetchPrStatuses).toHaveBeenCalledExactlyOnceWith({ id: 'p', key: 'ALPHA' }, connection, 'key');
    expect(prSync.applyPrStatuses).not.toHaveBeenCalled();
    const result = await apply();
    expect(connections.getFullByProject).toHaveBeenLastCalledWith('p', { lock: true });
    expect(prSync.applyPrStatuses).toHaveBeenCalledExactlyOnceWith({ id: 'p', key: 'ALPHA' }, connection, 'key', [], 'vcs.sync.pr', { isolate: false });
    expect(prSync.startExtractions).not.toHaveBeenCalled();
    await service.startPrExtractions(result);
    expect(prSync.startExtractions).toHaveBeenCalledExactlyOnceWith(result.extractions);
  });
  it('PR preparation refuses changed connection before strict apply', async () => {
    const apply = await service.prepareSyncPr('alpha');
    connection.repoName = 'changed';
    await expect(apply()).rejects.toThrow(ValidationAppException);
    expect(prSync.applyPrStatuses).not.toHaveBeenCalled();
  });
  it('immediate PR sync uses the best effort service without scheduling twice', async () => {
    expect(await service.syncPr('alpha')).toEqual({ updated: 1, skipped: 0, extractions: [] });
    expect(prSync.syncPrStatus).toHaveBeenCalledExactlyOnceWith({ id: 'p', key: 'ALPHA' }, connection, 'key', 'vcs.sync.pr');
    expect(prSync.startExtractions).not.toHaveBeenCalled();
  });
  it('a deleted connection is target drift during apply', async () => {
    const apply = await service.prepareSyncAll('alpha');
    connections.getFullByProject.mockRejectedValue(new NotFoundAppException({}, 'vcs'));
    await expect(apply()).rejects.toThrow(ValidationAppException);
    expect(sync.syncIssues).not.toHaveBeenCalled();
  });
  it('missing runtime key refuses manual service preparation', async () => {
    config.encryptionKey = null;
    await expect(service.prepareSyncAll('alpha')).rejects.toThrow(ValidationAppException);
    expect(provider.fetchIssues).not.toHaveBeenCalled();
  });
  it('AC-11: fetches once before the callback and never in apply', async () => {
    const apply = await service.prepareSyncAll('alpha');
    expect(connections.getFullByProject).toHaveBeenLastCalledWith('p');
    expect(provider.fetchIssues).toHaveBeenCalledOnce();
    expect(sync.syncIssues).not.toHaveBeenCalled();
    expect(await apply()).toEqual({ syncType: 'manual', issuesSynced: 1, issuesSkipped: 0, tickets: [{ ref: 'ALPHA-3', title: issue.title }] });
    expect(connections.getFullByProject).toHaveBeenLastCalledWith('p', { lock: true });
    expect(provider.fetchIssues).toHaveBeenCalledOnce();
    expect(provider.fetchIssue).not.toHaveBeenCalled();
    expect(sync.syncIssues).toHaveBeenCalledWith({ id: 'p', key: 'ALPHA' }, [issue], expect.objectContaining({ id: 'c' }), 'vcs.sync.all', { isolate: false });
  });
  it.each(['repoName', 'allowedAuthors'] as const)('rejects full-sync drift in %s before any writes', async (field) => {
    const apply = await service.prepareSyncAll('alpha');
    connection[field] = 'changed';
    await expect(apply()).rejects.toMatchObject({ prefix: 'vcs' });
    expect(sync.syncIssues).not.toHaveBeenCalled();
  });
  it('single sync parses the number and retains ticket refs and duplicate 409', async () => {
    expect(await service.syncIssue('alpha', '7')).toMatchObject({ issuesSynced: 1, tickets: [{ ref: 'ALPHA-3', title: issue.title }] });
    expect(provider.fetchIssue).toHaveBeenCalledWith(7);
    sync.syncIssue.mockResolvedValue({ action: 'skipped' });
    await expect(service.syncIssue('alpha', '7')).rejects.toMatchObject({ status: 409 });
  });
  it('immediate full sync keeps the fullSync best-effort path and project-key refs', async () => {
    sync.fullSync.mockResolvedValue({ issuesSynced: 1, issuesSkipped: 1, createdTickets: [{ number: 4, title: 'Four' }], errors: ['Issue 9: failed'] });
    expect(await service.syncAll('alpha')).toEqual({ syncType: 'manual', issuesSynced: 1, issuesSkipped: 1, tickets: [{ ref: 'ALPHA-4', title: 'Four' }] });
    expect(sync.fullSync).toHaveBeenCalledWith({ id: 'p', key: 'ALPHA' }, connection, 'key');
    expect(provider.fetchIssues).not.toHaveBeenCalled();
  });
  it('single prepare applies without fetching twice and ignores authors drift', async () => {
    const apply = await service.prepareSyncIssue('alpha', '7');
    connection.allowedAuthors = '["bob"]';
    expect(await apply()).toMatchObject({ issuesSynced: 1 });
    expect(connections.getFullByProject).toHaveBeenLastCalledWith('p', { lock: true });
    expect(provider.fetchIssue).toHaveBeenCalledOnce();
    expect(sync.filterByAllowedAuthors).not.toHaveBeenCalled();
  });
  it('single prepare checks target drift without another fetch', async () => {
    const apply = await service.prepareSyncIssue('alpha', '7');
    connection.repoName = 'changed';
    await expect(apply()).rejects.toMatchObject({ prefix: 'vcs' });
    expect(sync.syncIssue).not.toHaveBeenCalled();
    expect(provider.fetchIssue).toHaveBeenCalledOnce();
  });
});
