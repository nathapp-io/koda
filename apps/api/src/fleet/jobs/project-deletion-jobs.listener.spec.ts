import type { Mock } from 'vitest';
import { Logger } from '@nestjs/common';
import { ProjectDeletionJobsListener } from './project-deletion-jobs.listener';
import type { FleetJobsService } from './fleet-jobs.service';
import type { FleetJobLivePublisher } from './fleet-job-live.publisher';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import type { LiveFleetJobEvent } from '../../live/live-event';

/**
 * Review P2 remainder (US-001): the fleet half of a project soft-delete.
 *
 * The listener runs the quiesce and its audit entry in one transaction as the `system.project.quiesce`
 * writer, publishes the live events once that transaction committed, and never rejects: the delete it
 * reacts to has already committed, so a listener failure must not reach the delete's caller.
 */
describe('ProjectDeletionJobsListener (US-001)', () => {
  const live: LiveFleetJobEvent[] = [
    { id: 'live-1', type: 'fleet_job', projectId: 'p1', jobId: 'j1', state: 'CANCELLED', at: '2026-11-01T00:00:00.000Z' } as LiveFleetJobEvent,
  ];

  let jobs: { cancelForProjectDelete: Mock };
  let audit: { record: Mock };
  let publisher: { publish: Mock };
  let txManager: { run: Mock };
  let listener: ProjectDeletionJobsListener;
  let error: Mock;

  beforeEach(() => {
    jobs = { cancelForProjectDelete: vi.fn().mockResolvedValue({ cancelled: ['j1'], live }) };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    publisher = { publish: vi.fn() };
    txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
    listener = new ProjectDeletionJobsListener(
      jobs as unknown as FleetJobsService,
      audit as unknown as AuditRecorder,
      publisher as unknown as FleetJobLivePublisher,
      txManager as never,
    );
    error = vi.fn();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(error);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('AC-12: records one quiesce audit entry for the deleted project', async () => {
    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      key: 'system.project.quiesce',
      resourceType: 'project',
      resourceId: 'p1',
      projectId: 'p1',
    }));
    expect(jobs.cancelForProjectDelete).toHaveBeenCalledWith('p1');
  });

  it('AC-13: publishes the transition live events after the transaction resolved', async () => {
    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(live);
    expect(publisher.publish.mock.invocationCallOrder[0]).toBeGreaterThan(txManager.run.mock.invocationCallOrder[0]);
  });

  it('AC-14: resolves without rejecting when the quiesce fails', async () => {
    jobs.cancelForProjectDelete.mockRejectedValue(new Error('database is gone'));

    await expect(listener.onProjectSoftDeleted({ projectId: 'p1' })).resolves.toBeUndefined();
  });

  it('AC-15: logs the failure at error level', async () => {
    jobs.cancelForProjectDelete.mockRejectedValue(new Error('database is gone'));

    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('p1');
    expect(String(error.mock.calls[0][0])).toContain('database is gone');
  });

  it('AC-16: never publishes when the quiesce fails', async () => {
    jobs.cancelForProjectDelete.mockRejectedValue(new Error('database is gone'));

    await listener.onProjectSoftDeleted({ projectId: 'p1' });

    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
