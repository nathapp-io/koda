import { FleetJobsService } from './fleet-jobs.service';

describe('FleetJobsService thread handoff dispatch', () => {
  it('AC-12: checks thread idleness transactionally before creating a thread plan', async () => {
    const repo = {
      findRepo: vi.fn().mockResolvedValue({ id: 'r1', projectId: 'p1', defaultBranch: 'main' }),
      lockIdleThread: vi.fn().mockResolvedValue(false),
      createJob: vi.fn(),
    };
    const txManager = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    const service = new FleetJobsService(
      repo as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      { assertNotPaused: vi.fn().mockResolvedValue(undefined) } as never,
      txManager as never,
      {} as never,
      { resolveForDispatch: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
    );

    await expect(service.dispatch('u1', 'p1', {
      repoId: 'r1', command: 'PLAN', feature: 'auth', ref: 'feat/auth', planFrom: 'spec.md', maxCostUsd: 5,
    } as never, { threadId: 't1' })).rejects.toMatchObject({ code: 409, prefix: 'threads.busy', httpStatus: 409 });
    expect(repo.lockIdleThread).toHaveBeenCalledWith('t1');
    expect(repo.createJob).not.toHaveBeenCalled();
  });
});
