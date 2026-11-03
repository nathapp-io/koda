import type { Mock } from 'vitest';
import { Logger } from '@nestjs/common';
import { VcsProjectDeletionListener } from './vcs-project-deletion.listener';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsPollingService } from './vcs-polling.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';

/**
 * Review P2 remainder (US-002): the VCS half of a project soft-delete.
 *
 * The listener deactivates the project's active connections and records one `system.project.quiesce`
 * audit entry per connection in one transaction as that writer, then removes each schedule once the
 * transaction committed — never from inside it, so a rolled-back transaction leaves the schedules it
 * did not change alone. It never rejects: the delete it reacts to has already committed, so a listener
 * failure must not reach the delete's caller. The next polling tick still recovers, because
 * `findVcsConnectionById` no longer answers a deleted project's connection.
 */
describe('VcsProjectDeletionListener (US-002)', () => {
  let repo: { deactivateConnectionsForProject: Mock };
  let polling: { unschedulePolling: Mock };
  let audit: { record: Mock };
  let txManager: { run: Mock };
  let listener: VcsProjectDeletionListener;
  let error: Mock;

  beforeEach(() => {
    repo = { deactivateConnectionsForProject: vi.fn().mockResolvedValue(['c1', 'c2']) };
    polling = { unschedulePolling: vi.fn() };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
    listener = new VcsProjectDeletionListener(
      repo as unknown as IVcsRepository,
      polling as unknown as VcsPollingService,
      audit as unknown as AuditRecorder,
      txManager as never,
    );
    error = vi.fn();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(error);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('AC-1: unschedules every connection the deactivation answered, after the transaction resolved', async () => {
    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(repo.deactivateConnectionsForProject).toHaveBeenCalledWith('p1');
    expect(polling.unschedulePolling.mock.calls).toEqual([['c1'], ['c2']]);
    expect(polling.unschedulePolling.mock.invocationCallOrder[0])
      .toBeGreaterThan(txManager.run.mock.invocationCallOrder[0]);
  });

  it('AC-2: records one quiesce entry with resourceType vcs-connection per deactivated connection', async () => {
    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(audit.record.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ key: 'system.project.quiesce', resourceType: 'vcs-connection', resourceId: 'c1', projectId: 'p1' }),
      expect.objectContaining({ key: 'system.project.quiesce', resourceType: 'vcs-connection', resourceId: 'c2', projectId: 'p1' }),
    ]);
    // The entries commit or roll back with the deactivation, so they are recorded inside it.
    expect(audit.record.mock.invocationCallOrder[0])
      .toBeGreaterThan(txManager.run.mock.invocationCallOrder[0]);
    expect(audit.record.mock.invocationCallOrder[1])
      .toBeLessThan(polling.unschedulePolling.mock.invocationCallOrder[0]);
  });

  it('AC-3: records no audit entry when nothing was deactivated', async () => {
    repo.deactivateConnectionsForProject.mockResolvedValue([]);

    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(audit.record).not.toHaveBeenCalled();
    expect(polling.unschedulePolling).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('AC-4: resolves without rejecting when the deactivation fails', async () => {
    repo.deactivateConnectionsForProject.mockRejectedValue(new Error('database is gone'));

    await expect(listener.onProjectSoftDeleted({ projectId: 'p1' })).resolves.toBeUndefined();
  });

  it('AC-5: logs the failure at error level', async () => {
    repo.deactivateConnectionsForProject.mockRejectedValue(new Error('database is gone'));

    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('p1');
    expect(String(error.mock.calls[0][0])).toContain('database is gone');
  });

  it('AC-6: never unschedules a connection when the deactivation failed', async () => {
    repo.deactivateConnectionsForProject.mockRejectedValue(new Error('database is gone'));

    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(polling.unschedulePolling).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
