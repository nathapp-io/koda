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
    await expect(service.plan('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409 });
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