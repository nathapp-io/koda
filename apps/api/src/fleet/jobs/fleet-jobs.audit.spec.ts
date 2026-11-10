import { FleetJobsService } from './fleet-jobs.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';

describe('FleetJobsService transactional audit', () => {
  const job = { id: 'j', projectId: 'p', repoId: 'r', command: 'RUN', feature: 'secret', state: 'QUEUED', profiles: [], selectorLabels: [], queuedAt: new Date(), updatedAt: new Date(), costSpentUsd: '0', costCarriedUsd: '0' } as FleetJobRecord;

  function setup(current = job) {
    let inside = false;
    const order: string[] = [];
    const repo = {
      findRepo: vi.fn().mockResolvedValue({ id: 'r', projectId: 'p', defaultBranch: 'main' }),
      createJob: vi.fn(async () => { order.push('create'); return current; }),
      lockIdleThread: vi.fn().mockResolvedValue(true),
      lockById: vi.fn().mockResolvedValue(current), findById: vi.fn().mockResolvedValue(current),
      appendEvent: vi.fn(), findPendingCommand: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(current), createCommand: vi.fn(), withdrawPendingCommands: vi.fn(),
    };
    const record = vi.fn(async () => { expect(inside).toBe(true); order.push('audit'); });
    const transitions = { apply: vi.fn(async () => { order.push('transition'); return { job: current, live: {} }; }) };
    const args = [repo, { placeJob: vi.fn().mockResolvedValue({ assigned: false, misfits: [] }) },
      { record: vi.fn(async () => { order.push('activity'); }) }, { publish: vi.fn(), event: vi.fn() },
      transitions, { notify: vi.fn() }, { assertNotPaused: vi.fn() },
      { run: async (fn: () => Promise<unknown>) => { inside = true; try { return await fn(); } finally { inside = false; } } },
      { countPendingByJob: vi.fn().mockResolvedValue(new Map()) },
      { resolveForDispatch: vi.fn().mockResolvedValue([]), link: vi.fn(), forJob: vi.fn().mockResolvedValue([]) }, {}, {}, { record },
      { selectForReview: vi.fn().mockResolvedValue([]) }, { snapshotForFix: vi.fn().mockResolvedValue(undefined) }];
    // Include the new dependency before implementation, without hiding missing calls.
    const service = new FleetJobsService(...args as unknown as ConstructorParameters<typeof FleetJobsService>);
    return { service, record, repo, order };
  }

  it.each([undefined, 'thread.plan', 'thread.run'] as const)('AC-4/5: records dispatch once, in transaction after activity, key %s', async (auditKey) => {
    const { service, record, order } = setup();
    await service.dispatch('u', 'p', { repoId: 'r', command: 'RUN', feature: 'secret', maxCostUsd: 5 }, { auditKey });
    expect(record).toHaveBeenCalledExactlyOnceWith({ key: auditKey ?? 'fleet.job.dispatch', resourceType: 'fleet-job', resourceId: 'j', projectId: 'p', summary: 'RUN on repo r' });
    expect(order).toEqual(['create', 'activity', 'audit']);
  });

  it('includes only thread and schedule identifiers in dispatch summary', async () => {
    const { service, record } = setup({ ...job, threadId: 't', scheduleId: 's' });
    await service.dispatch('u', 'p', { repoId: 'r', command: 'RUN', feature: 'secret', maxCostUsd: 5 }, { threadId: 't', scheduleId: 's' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ summary: 'RUN on repo r, thread t, schedule s' }));
  });

  it.each(['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING'])('audits cancel from %s', async (state) => {
    const { service, record, repo } = setup({ ...job, state, runnerId: 'runner' });
    if (state === 'ASSIGNED') repo.findPendingCommand.mockResolvedValue({ id: 'assign' });
    await service.cancel('u', 'p', 'j', true);
    expect(record).toHaveBeenCalledExactlyOnceWith({ key: 'fleet.job.cancel', resourceType: 'fleet-job', resourceId: 'j', projectId: 'p', summary: `${['QUEUED', 'ASSIGNED'].includes(state) ? 'cancelled from' : 'cancel requested in'} ${state}` });
  });

  describe('cancelBeforeRunner (#428)', () => {
    const threadAudit = { key: 'thread.stop', resourceType: 'thread', resourceId: 't', projectId: 'p', summary: 'stop cancelled the queued turn' };

    it('cancels a QUEUED job server-side and records the job and thread audit entries in the transaction', async () => {
      const { service, record, order } = setup({ ...job, state: 'QUEUED' });
      await expect(service.cancelBeforeRunner('u', 'p', 'j', threadAudit)).resolves.toBe(true);
      expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: 'fleet.job.cancel', summary: 'cancelled from QUEUED' }));
      expect(record).toHaveBeenNthCalledWith(2, threadAudit);
      expect(order).toEqual(['transition', 'audit', 'audit']);
    });

    it('cancels an ASSIGNED job whose ASSIGN was never acked', async () => {
      const { service, repo } = setup({ ...job, state: 'ASSIGNED', runnerId: 'runner' });
      repo.findPendingCommand.mockResolvedValue({ id: 'assign' });
      await expect(service.cancelBeforeRunner('u', 'p', 'j', threadAudit)).resolves.toBe(true);
    });

    it.each(['ASSIGNED', 'RUNNING', 'UPLOADING', 'CANCELLED', 'COMPLETED'])('answers false for a job a runner holds or that ended (%s), writing nothing and throwing nothing', async (state) => {
      const { service, record, repo, order } = setup({ ...job, state, runnerId: 'runner' });
      await expect(service.cancelBeforeRunner('u', 'p', 'j', threadAudit)).resolves.toBe(false);
      expect(order).toEqual([]);
      expect(record).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.createCommand).not.toHaveBeenCalled();
    });

    it('answers false for a missing job or one of another project', async () => {
      const { service, repo } = setup();
      await expect(service.cancelBeforeRunner('u', 'other', 'j', threadAudit)).resolves.toBe(false);
      repo.lockById.mockResolvedValue(null);
      await expect(service.cancelBeforeRunner('u', 'p', 'j', threadAudit)).resolves.toBe(false);
    });
  });

  it('AC-9: does not audit an already requested cancel', async () => {
    const { service, record } = setup({ ...job, state: 'RUNNING', runnerId: 'runner', cancelRequestedAt: new Date() });
    await service.cancel('u', 'p', 'j', true);
    expect(record).not.toHaveBeenCalled();
  });

  it.each(['FAILED', 'CRASHED', 'CANCELLED'])('audits requeue after transition from %s', async (state) => {
    const { service, record, order } = setup({ ...job, state });
    await service.requeue('u', 'p', 'j');
    expect(record).toHaveBeenCalledExactlyOnceWith({ key: 'fleet.job.requeue', resourceType: 'fleet-job', resourceId: 'j', projectId: 'p', summary: `requeued from ${state}` });
    expect(order).toEqual(['transition', 'audit']);
  });

  it('AC-6: propagates recorder failure before placement', async () => {
    const { service, record } = setup();
    record.mockRejectedValue(new Error('audit unavailable'));
    await expect(service.dispatch('u', 'p', { repoId: 'r', command: 'RUN', feature: 'secret', maxCostUsd: 5 })).rejects.toThrow('audit unavailable');
  });
});
