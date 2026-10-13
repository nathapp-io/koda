import { ConfigType } from '@nestjs/config';
import { fleetConfig } from '../../config/fleet.config';
import { SkillsService } from '../../skills/skills.service';
import type { IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { ChatThreadRecord, ChatThreadRepository } from './domain/chat-thread.domain';
import { ThreadsService } from './threads.service';

const record: ChatThreadRecord = {
  id: 't1', repoId: 'r1', baseRef: 'main', feature: 'auth', title: 'T', createdById: 'u1', runnerId: null,
  backend: { kind: 'native', model: 'm1' }, status: 'ACTIVE', archivedAt: null, skills: [],
  maxCostUsd: '5', costUsd: '0', tokens: null, specPath: '.nax/features/auth/spec.md', pendingQuestion: null,
  session: null, lastActivityAt: new Date('2026-10-01T00:00:00.000Z'), createdAt: new Date('2026-10-01T00:00:00.000Z'),
  activeJob: null, writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
};

describe('ThreadsService.list', () => {
  it('US-001 AC10: answers { items, threadsEnabled } with threadsEnabled read from the config at each call', async () => {
    const threads = { list: vi.fn().mockResolvedValue([record]) } as unknown as ChatThreadRepository;
    const config: ConfigType<typeof fleetConfig> = { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>;
    const service = new ThreadsService(
      threads,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      config,
      {} as unknown as FleetJobsService,
    );

    const open = await service.list('p1', undefined, 0, 20);
    expect(open.items).toEqual([record]);
    expect(open.threadsEnabled).toBe(true);

    config.threadsEnabled = false;
    const closed = await service.list('p1', undefined, 0, 20);
    expect(closed.threadsEnabled).toBe(false);
  });
});

describe('ThreadsService.plan (US-006)', () => {
  it('dispatches a published thread plan on its feature branch with default cap and thread id', async () => {
    const dispatch = vi.fn().mockResolvedValue({ job: { id: 'j1' } });
    const threads = { get: vi.fn().mockResolvedValue({ ...record, specPublished: true, runnerId: 'runner-1' }) } as unknown as ChatThreadRepository;
    const service = new ThreadsService(
      threads,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      { dispatch } as unknown as FleetJobsService,
    );

    await service.plan('p1', 't1', 'u1', {});
    expect(dispatch).toHaveBeenCalledWith('u1', 'p1', {
      repoId: 'r1', command: 'PLAN', ref: 'feat/auth', feature: 'auth',
      planFrom: '.nax/features/auth/spec.md', profiles: undefined, maxCostUsd: 5, pinnedRunnerId: 'runner-1',
    }, { threadId: 't1' });
  });

  it('refuses before dispatch when the thread spec is unpublished', async () => {
    const dispatch = vi.fn();
    const threads = { get: vi.fn().mockResolvedValue(record) } as unknown as ChatThreadRepository;
    const service = new ThreadsService(
      threads,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      { dispatch } as unknown as FleetJobsService,
    );
    await expect(service.plan('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.notPublished', httpStatus: 409 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('ThreadsService.run (US-007)', () => {
  const completedPlan = { plan: { jobId: 'plan-1', state: 'COMPLETED', stateReason: null }, run: null };
  const runService = (threads: Partial<ChatThreadRepository>, dispatch: ReturnType<typeof vi.fn>, enabled = true) => new ThreadsService(
    threads as ChatThreadRepository,
    {} as unknown as IFleetRepoRepository,
    {} as unknown as SkillsService,
    { threadsEnabled: enabled } as unknown as ConfigType<typeof fleetConfig>,
    { dispatch } as unknown as FleetJobsService,
  );

  it('AC-1: dispatches a RUN on the feature branch pinned to the thread runner, with the default cap and thread id', async () => {
    const dispatch = vi.fn().mockResolvedValue({ job: { id: 'j1' } });
    const service = runService({
      get: vi.fn().mockResolvedValue({ ...record, runnerId: 'runner-1' }),
      handoff: vi.fn().mockResolvedValue(completedPlan),
    }, dispatch);

    await service.run('p1', 't1', 'u1', {});
    expect(dispatch).toHaveBeenCalledWith('u1', 'p1', {
      repoId: 'r1', command: 'RUN', ref: 'feat/auth', feature: 'auth',
      profiles: undefined, maxCostUsd: 5, bashMode: undefined, pinnedRunnerId: 'runner-1',
    }, { threadId: 't1' });
  });

  it('AC-2: refuses with threads.notPlanned when the thread has no PLAN job', async () => {
    const dispatch = vi.fn();
    const service = runService({
      get: vi.fn().mockResolvedValue(record),
      handoff: vi.fn().mockResolvedValue({ plan: null, run: null }),
    }, dispatch);

    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.notPlanned', httpStatus: 409 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('AC-3: refuses with threads.notPlanned when the latest PLAN job is not COMPLETED', async () => {
    const dispatch = vi.fn();
    const service = runService({
      get: vi.fn().mockResolvedValue(record),
      handoff: vi.fn().mockResolvedValue({ plan: { jobId: 'plan-2', state: 'FAILED', stateReason: 'branch_mismatch' }, run: null }),
    }, dispatch);

    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.notPlanned', httpStatus: 409 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('AC-4: forwards the bashMode and profiles the caller chose', async () => {
    const dispatch = vi.fn().mockResolvedValue({ job: { id: 'j1' } });
    const service = runService({
      get: vi.fn().mockResolvedValue({ ...record, runnerId: 'runner-1' }),
      handoff: vi.fn().mockResolvedValue(completedPlan),
    }, dispatch);

    await service.run('p1', 't1', 'u1', { bashMode: 'escalate', profiles: ['native'], maxCostUsd: 3 });
    expect(dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({
      command: 'RUN', profiles: ['native'], bashMode: 'escalate', maxCostUsd: 3,
    }), { threadId: 't1' });
  });

  it('refuses with threads.disabled before reading the plan when threads are off', async () => {
    const dispatch = vi.fn();
    const handoff = vi.fn();
    const service = runService({ get: vi.fn().mockResolvedValue(record), handoff }, dispatch, false);

    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.disabled' });
    expect(handoff).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses with threads.archived for an archived thread', async () => {
    const dispatch = vi.fn();
    const service = runService({ get: vi.fn().mockResolvedValue({ ...record, status: 'ARCHIVED' }), handoff: vi.fn().mockResolvedValue(completedPlan) }, dispatch);

    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.archived' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not the thread creator with threads.notCreator', async () => {
    const dispatch = vi.fn();
    const service = runService({ get: vi.fn().mockResolvedValue({ ...record, createdById: 'someone-else' }), handoff: vi.fn().mockResolvedValue(completedPlan) }, dispatch);

    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ status: 403, prefix: 'threads.notCreator' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('ThreadsService.discard (US-004)', () => {
  it('AC-1: passes the project, thread and user to the repository and returns its { jobId }', async () => {
    const discard = vi.fn().mockResolvedValue({ jobId: 'job-d1' });
    const threads = { discard } as unknown as ChatThreadRepository;
    const service = new ThreadsService(
      threads,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      {} as unknown as FleetJobsService,
    );

    await expect(service.discard('p1', 't1', 'u1')).resolves.toEqual({ jobId: 'job-d1' });
    expect(discard).toHaveBeenCalledWith('p1', 't1', 'u1');
  });
});