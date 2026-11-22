import { createMock } from '@golevelup/ts-vitest';
import type { IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import type { RunnerNotifier } from '../jobs/runner-notifier';
import type { SyncResponse } from '../common/protocol';
import { SyncService } from './sync.service';

const base = { protocolVersion: 4, bootId: 'b1', daemonVersion: '1', freeSlots: 0, jobs: [], commandAcks: [] };

/**
 * US-005: the long-poll readiness predicate and the atomic consumption of a re-probe request. The
 * harness leaves every collaborator but the job repository and the notifier mocked — the request
 * column lives on the runner row, which this service reaches only through those two methods.
 */
function harness() {
  const repository = createMock<IFleetJobRepository>();
  repository.recordRunnerSync.mockResolvedValue({ previousBootId: 'b1', enabled: true });
  repository.findPendingCommands.mockResolvedValue([]);
  repository.hasPendingReprobe.mockResolvedValue(false);
  repository.takeReprobeRequest.mockResolvedValue(false);
  const notifier = createMock<RunnerNotifier>();
  const service = new SyncService(
    repository, createMock(), createMock({ process: async () => ({ live: [] }) }), createMock(), createMock(), notifier,
    { syncWaitMs: 5_000 }, createMock(), createMock(), createMock(), createMock(), createMock(),
    createMock(), createMock({ archivedThreadIds: async () => [] }), createMock(), createMock(),
  );
  return { repository, notifier, sync: () => service.sync('runner-1', { ...base }) as Promise<SyncResponse> };
}

describe('SyncService re-probe delivery', () => {
  it('AC-7: an idle sync waits with a ready predicate that is true for a pending re-probe', async () => {
    const h = harness();
    h.repository.hasPendingReprobe.mockResolvedValue(true);
    await h.sync();

    expect(h.notifier.wait).toHaveBeenCalledOnce();
    const [runnerId, ms, ready] = h.notifier.wait.mock.calls[0] ?? [];
    expect(runnerId).toBe('runner-1');
    expect(ms).toBe(5_000);
    if (!ready) throw new Error('wait was called without a ready predicate');
    await expect(ready()).resolves.toBe(true);
    expect(h.repository.hasPendingReprobe).toHaveBeenCalledWith('runner-1');
  });

  it('AC-7: the same predicate answers true for a pending command, not only a re-probe', async () => {
    const h = harness();
    // The first deliver sees no command, so the sync is idle; the ready predicate then finds one.
    h.repository.findPendingCommands.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'c1' }] as never);
    await h.sync();
    const ready = h.notifier.wait.mock.calls[0]?.[2];
    if (!ready) throw new Error('wait was called without a ready predicate');
    await expect(ready()).resolves.toBe(true);
  });

  it('AC-8: a taken re-probe request is delivered as reprobe: true', async () => {
    const h = harness();
    h.repository.takeReprobeRequest.mockResolvedValue(true);
    const response = await h.sync();
    expect(h.repository.takeReprobeRequest).toHaveBeenCalledWith('runner-1');
    expect(response.reprobe).toBe(true);
  });

  it('AC-9: a non-boolean truthy take result is not delivered', async () => {
    const h = harness();
    h.repository.takeReprobeRequest.mockResolvedValue({} as never);
    const response = await h.sync();
    expect(h.repository.takeReprobeRequest).toHaveBeenCalledWith('runner-1');
    expect(Object.prototype.hasOwnProperty.call(response, 'reprobe')).toBe(false);
  });

  it('AC-9: no pending request leaves the reprobe key absent', async () => {
    const h = harness();
    const response = await h.sync();
    expect(h.repository.takeReprobeRequest).toHaveBeenCalledWith('runner-1');
    expect(Object.prototype.hasOwnProperty.call(response, 'reprobe')).toBe(false);
  });
});
