import { ConfigType } from '@nestjs/config';
import { fleetConfig } from '../../config/fleet.config';
import { SkillsService } from '../../skills/skills.service';
import type { IFleetRepoRepository, FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { ChatThreadRecord, ChatMessageRecord, ChatThreadRepository } from './domain/chat-thread.domain';
import type { ProjectBriefService } from './project-brief.service';
import { ThreadsService } from './threads.service';

/**
 * The ProjectBriefService stub every construction passes (S5b US-003): a fixed repository section and no repository
 * read, so an existing expectation never depends on the brief block.
 */
const briefStub = (section = 'Repository context: unavailable (no repository)') =>
  ({ resolveRepoContext: vi.fn(async () => section) }) as unknown as ProjectBriefService;

const record: ChatThreadRecord = {
  id: 't1', kind: 'REPO', projectId: 'p1', repoId: 'r1', baseRef: 'main', feature: 'auth', title: 'T', createdById: 'u1', runnerId: null,
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
      briefStub(),
    );

    const open = await service.list('p1', undefined, 0, 20);
    expect(open.items).toEqual([record]);
    expect(open.threadsEnabled).toBe(true);

    config.threadsEnabled = false;
    const closed = await service.list('p1', undefined, 0, 20);
    expect(closed.threadsEnabled).toBe(false);
  });
});

describe('ThreadsService.get (US-003 AC-12)', () => {
  it('passes a stored session notice through unchanged, with the send refusal and handoff beside it', async () => {
    const session = {
      jobId: 'j1', state: 'live' as const, resumed: false, contextReset: false, reason: null, at: 'A', projectCodeUnavailableOn: 'wk-mac',
    };
    const threads = {
      get: vi.fn().mockResolvedValue({ ...record, kind: 'PROJECT', repoId: null, session }),
      sendRefusalOf: vi.fn().mockResolvedValue(null),
      handoff: vi.fn().mockResolvedValue({ plan: null, run: null }),
      pendingActions: vi.fn().mockResolvedValue([]),
    } as unknown as ChatThreadRepository;
    const service = new ThreadsService(
      threads,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      {} as unknown as FleetJobsService,
      briefStub(),
    );

    const thread = await service.get('p1', 't1');

    expect(thread.session).toEqual(session);
  });
});

describe('ThreadsService.get pending actions (S5b US-004)', () => {
  const action = {
    id: 'a1', approvalId: 'ap1', tool: 'koda_add_comment', preview: 'Add a comment to KODA-1 "Fix login":\n\nhello',
    projectSlug: 'web', expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'),
  };

  it('AC-1..AC-3: the project detail answers the repository\'s pending actions of that thread, unchanged', async () => {
    const pendingActions = vi.fn().mockResolvedValue([action]);
    const threads = {
      get: vi.fn().mockResolvedValue(record), sendRefusalOf: vi.fn().mockResolvedValue(null),
      handoff: vi.fn().mockResolvedValue({ plan: null, run: null }), pendingActions,
    } as unknown as ChatThreadRepository;
    const service = new ThreadsService(
      threads,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      {} as unknown as FleetJobsService,
      briefStub(),
    );

    const thread = await service.get('p1', 't1');

    expect(thread.pendingActions).toEqual([action]);
    expect(pendingActions).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1');
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
      briefStub(),
    );

    await service.plan('p1', 't1', 'u1', {});
    expect(dispatch).toHaveBeenCalledWith('u1', 'p1', {
      repoId: 'r1', command: 'PLAN', ref: 'feat/auth', feature: 'auth',
      planFrom: '.nax/features/auth/spec.md', profiles: undefined, maxCostUsd: 5, pinnedRunnerId: 'runner-1',
    }, { threadId: 't1' });
  });

  it('refuses a published thread whose owning runner was deleted', async () => {
    const dispatch = vi.fn();
    const threads = { get: vi.fn().mockResolvedValue({ ...record, specPublished: true, runnerId: null }) } as unknown as ChatThreadRepository;
    const service = new ThreadsService(threads, {} as unknown as IFleetRepoRepository, {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>, { dispatch } as unknown as FleetJobsService, briefStub());
    await expect(service.plan('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.runnerMissing' });
    expect(dispatch).not.toHaveBeenCalled();
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
      briefStub(),
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
    briefStub(),
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

  it('refuses a completed plan whose owning runner was deleted', async () => {
    const dispatch = vi.fn();
    const service = runService({
      get: vi.fn().mockResolvedValue({ ...record, runnerId: null }),
      handoff: vi.fn().mockResolvedValue(completedPlan),
    }, dispatch);
    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ code: 409, prefix: 'threads.runnerMissing' });
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

  it('refuses a caller who is not the thread creator with 403 permissions when canOperate is false', async () => {
    const dispatch = vi.fn();
    const service = runService({ get: vi.fn().mockResolvedValue({ ...record, createdById: 'someone-else' }), handoff: vi.fn().mockResolvedValue(completedPlan) }, dispatch);

    await expect(service.run('p1', 't1', 'u1', {})).rejects.toMatchObject({ status: 403, prefix: 'permissions' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('US-002: runs another creator\'s thread as the caller when the any-row key holder passes canOperate', async () => {
    const dispatch = vi.fn().mockResolvedValue({ job: { id: 'j1' } });
    const service = runService({ get: vi.fn().mockResolvedValue({ ...record, createdById: 'someone-else', runnerId: 'runner-1' }), handoff: vi.fn().mockResolvedValue(completedPlan) }, dispatch);

    await service.run('p1', 't1', 'u1', {}, true);

    expect(dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'RUN' }), { threadId: 't1' });
  });
});

describe('ThreadsService.create (US-003)', () => {
  const createService = (over: {
    config?: Partial<ConfigType<typeof fleetConfig>>;
    repos?: Partial<IFleetRepoRepository>;
    threads?: Partial<ChatThreadRepository>;
    snapshot?: ReturnType<typeof vi.fn>;
  } = {}) => {
    const create = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ ...record, ...input }));
    const findAnchor = vi.fn().mockResolvedValue({ id: 'r-anchor' });
    const findById = vi.fn().mockResolvedValue({ id: 'r1', projectId: 'p1', defaultBranch: 'trunk' });
    const snapshotForProject = over.snapshot ?? vi.fn().mockResolvedValue([]);
    const service = new ThreadsService(
      { create, ...over.threads } as unknown as ChatThreadRepository,
      { findAnchor, findById, ...over.repos } as unknown as IFleetRepoRepository,
      { snapshotForProject } as unknown as SkillsService,
      { threadsEnabled: true, ...over.config } as unknown as ConfigType<typeof fleetConfig>,
      {} as unknown as FleetJobsService,
      briefStub(),
    );
    return { service, create, findAnchor, findById, snapshotForProject };
  };

  it('AC-11/12: creates a PROJECT thread against the project anchor with no repo lookup and null repo fields', async () => {
    const { service, create, findAnchor, findById } = createService();
    await service.create('p1', 'u1', { kind: 'PROJECT', title: 'Brainstorm', backend: { kind: 'native', model: 'm1' } });

    expect(findAnchor).toHaveBeenCalledWith('p1');
    expect(findById).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      kind: 'PROJECT', projectId: 'p1', repoId: null, baseRef: null, feature: null, title: 'Brainstorm',
      createdById: 'u1', backend: { kind: 'native', model: 'm1' }, skills: [], maxCostUsd: '5',
    });
  });

  it('AC-13: refuses a PROJECT thread with threads.noFleetRepo when the project has no fleet repo', async () => {
    const { service, create, snapshotForProject } = createService({ repos: { findAnchor: vi.fn().mockResolvedValue(null) } });
    await expect(service.create('p1', 'u1', { kind: 'PROJECT', title: 'Brainstorm', backend: { kind: 'native' } }))
      .rejects.toMatchObject({ code: 409, prefix: 'threads.noFleetRepo', httpStatus: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(snapshotForProject).not.toHaveBeenCalled();
  });

  it('keeps the REPO two-pass flow: the repo branch validates the baseRef and the created row carries the repo', async () => {
    const { service, create, findAnchor, findById } = createService();
    await service.create('p1', 'u1', { repoId: 'r1', feature: 'add-auth', title: 'Add auth', backend: { kind: 'native' } });

    expect(findById).toHaveBeenCalledWith('r1');
    expect(findAnchor).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REPO', repoId: 'r1', baseRef: 'trunk', feature: 'add-auth' }));
  });

  it('refuses a REPO create whose repo belongs to another project before any write', async () => {
    const { service, create } = createService({ repos: { findById: vi.fn().mockResolvedValue({ id: 'r1', projectId: 'other', defaultBranch: 'trunk' }) } });
    await expect(service.create('p1', 'u1', { repoId: 'r1', feature: 'add-auth', title: 'Add auth', backend: { kind: 'native' } }))
      .rejects.toMatchObject({ code: 404, prefix: 'fleet.repos' });
    expect(create).not.toHaveBeenCalled();
  });

  it('gates PROJECT exactly as it gates REPO: threads.disabled wins', async () => {
    const { service, create, findAnchor } = createService({ config: { threadsEnabled: false } });
    await expect(service.create('p1', 'u1', { kind: 'PROJECT', title: 'Brainstorm', backend: { kind: 'native' } }))
      .rejects.toMatchObject({ code: 409, prefix: 'threads.disabled' });
    expect(findAnchor).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('ThreadsService.discard (US-004)', () => {
  const discardService = (discard: ReturnType<typeof vi.fn>) => new ThreadsService(
    { discard } as unknown as ChatThreadRepository,
    {} as unknown as IFleetRepoRepository,
    {} as unknown as SkillsService,
    { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
    {} as unknown as FleetJobsService,
    briefStub(),
  );

  it('AC-1: passes the project, thread and user to the repository and returns its { jobId }', async () => {
    const discard = vi.fn().mockResolvedValue({ jobId: 'job-d1' });
    const service = discardService(discard);

    await expect(service.discard('p1', 't1', 'u1')).resolves.toEqual({ jobId: 'job-d1' });
    // US-002: the creator compare is the repository's, and `canOperate` rides last (absent = false).
    expect(discard).toHaveBeenCalledWith('p1', 't1', 'u1', false);
  });

  it('US-002: forwards the any-row key holder\'s canOperate so the repository skips the creator compare', async () => {
    const discard = vi.fn().mockResolvedValue({ jobId: 'job-d2' });
    const service = discardService(discard);

    await service.discard('p1', 't1', 'u1', true);

    expect(discard).toHaveBeenCalledWith('p1', 't1', 'u1', true);
  });
});

describe('ThreadsService.sendMessage repository context (S5b US-003)', () => {
  const SECTION = 'Repository context: unavailable (no repository)';
  const message: ChatMessageRecord = {
    id: 'm1', seq: 1, jobId: 'j1', turnId: 'j1', role: 'user', authorUserId: 'u1', clientMessageId: 'c1',
    content: 'hi', toolSummary: null, status: 'pending', errorReason: null, usage: null, costUsd: null,
    costSource: null, createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  /**
   * A service whose brief stub, thread read and repository call all record into `order`, so the order of the two
   * calls the brief block depends on is asserted, not just their arguments.
   */
  const serviceFor = (thread: ChatThreadRecord | null, anchor: { id: string } | null = { id: 'r-anchor' }) => {
    const order: string[] = [];
    const resolveRepoContext = vi.fn(async (repoId: string | null) => {
      order.push(`resolve:${repoId === null ? 'null' : repoId}`);
      return SECTION;
    });
    const findAnchor = vi.fn(async () => anchor as FleetRepoRecord | null);
    const sendMessage = vi.fn(async (input: { repoContext?: string }) => {
      order.push(`send:${input.repoContext ?? 'none'}`);
      return { message, jobId: 'j1', deduplicated: false };
    });
    const get = vi.fn(async () => thread);
    const service = new ThreadsService(
      { get, sendMessage } as unknown as ChatThreadRepository,
      { findAnchor } as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      {} as unknown as FleetJobsService,
      { resolveRepoContext } as unknown as ProjectBriefService,
    );
    return { service, order, resolveRepoContext, findAnchor, sendMessage, get };
  };

  const projectThread: ChatThreadRecord = { ...record, kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null };
  const send = (service: ThreadsService) => service.sendMessage('p1', 't1', 'u1', { text: 'hi', clientMessageId: 'c1' });

  it('AC-7: a PROJECT send resolves the anchor repository context once, before the repository call', async () => {
    const { service, order, resolveRepoContext, findAnchor, sendMessage } = serviceFor(projectThread);

    await send(service);

    expect(findAnchor).toHaveBeenCalledWith('p1');
    expect(resolveRepoContext).toHaveBeenCalledTimes(1);
    expect(resolveRepoContext).toHaveBeenCalledWith('r-anchor');
    expect(sendMessage).toHaveBeenCalledWith({ scope: { kind: 'project', projectId: 'p1' }, threadId: 't1', userId: 'u1', text: 'hi', clientMessageId: 'c1', repoContext: SECTION, canOperate: false });
    expect(order).toEqual(['resolve:r-anchor', `send:${SECTION}`]);
  });

  it('AC-8: a REPO send resolves the thread own repository context and reads no anchor', async () => {
    const { service, resolveRepoContext, findAnchor } = serviceFor(record);

    await send(service);

    expect(resolveRepoContext).toHaveBeenCalledWith('r1');
    expect(findAnchor).not.toHaveBeenCalled();
  });

  it('AC-9: a PROJECT send in a project with no fleet repo resolves a null repository', async () => {
    const { service, resolveRepoContext, sendMessage } = serviceFor(projectThread, null);

    await send(service);

    expect(resolveRepoContext).toHaveBeenCalledWith(null);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ repoContext: SECTION }));
  });

  it('skips the resolution and passes no repoContext when the thread is not there, so the repository answers not found', async () => {
    const { service, resolveRepoContext, sendMessage, get } = serviceFor(null);

    await send(service);

    expect(get).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1');
    expect(resolveRepoContext).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ repoContext: undefined }));
  });
});

/**
 * Permissions P1 US-002: ownership comes from the keys. Every project write forwards the handler's
 * `canOperate` — true only for an any-row key holder — and the repository keeps its creator compare
 * when it is false. The default is false, so the unchanged workspace call sites keep the compare.
 */
describe('ThreadsService canOperate (US-002)', () => {
  const message: ChatMessageRecord = {
    id: 'm1', seq: 1, jobId: 'j1', turnId: 'j1', role: 'user', authorUserId: 'u1', clientMessageId: 'c1',
    content: 'hi', toolSummary: null, status: 'pending', errorReason: null, usage: null, costUsd: null,
    costSource: null, createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  const serviceFor = (threads: Partial<ChatThreadRepository>) => new ThreadsService(
    {
      updateCap: vi.fn(async (..._args: unknown[]) => record),
      command: vi.fn(async () => undefined),
      publish: vi.fn(async () => ({ jobId: null })),
      sendMessage: vi.fn(async () => ({ message, jobId: 'j1', deduplicated: false })),
      get: vi.fn(async () => record),
      ...threads,
    } as unknown as ChatThreadRepository,
    {} as unknown as IFleetRepoRepository,
    {} as unknown as SkillsService,
    { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
    { dispatch: vi.fn() } as unknown as FleetJobsService,
    briefStub(),
  );

  it('forwards canOperate to updateCap, stop, endSession, answer, publish and sendMessage', async () => {
    const threads = {
      updateCap: vi.fn(async () => record),
      command: vi.fn(async () => undefined),
      publish: vi.fn(async () => ({ jobId: null })),
      sendMessage: vi.fn(async () => ({ message, jobId: 'j1', deduplicated: false })),
      get: vi.fn(async () => record),
    };
    const service = serviceFor(threads);

    await service.updateCap('p1', 't1', 'u1', 3, true);
    await service.stop('p1', 't1', 'u1', true);
    await service.endSession('p1', 't1', 'u1', true);
    await service.answer('p1', 't1', 'u1', { requestId: 'q1', text: 'yes' }, true);
    await service.publish('p1', 't1', 'u1', true);
    await service.sendMessage('p1', 't1', 'u1', { text: 'hi', clientMessageId: 'c1' }, true);

    expect(threads.updateCap).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', '3', true);
    expect(threads.command).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', 'THREAD_STOP_TURN', {}, true);
    expect(threads.command).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', 'THREAD_CLOSE', {}, true);
    expect(threads.command).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', 'THREAD_ANSWER', { requestId: 'q1', text: 'yes' }, true);
    expect(threads.publish).toHaveBeenCalledWith('p1', 't1', 'u1', true);
    expect(threads.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1', userId: 'u1', canOperate: true }));
  });

  it('defaults canOperate to false, so a caller that passes nothing keeps the creator compare', async () => {
    const threads = {
      updateCap: vi.fn(async () => record),
      command: vi.fn(async () => undefined),
      publish: vi.fn(async () => ({ jobId: null })),
      sendMessage: vi.fn(async () => ({ message, jobId: 'j1', deduplicated: false })),
      get: vi.fn(async () => record),
    };
    const service = serviceFor(threads);

    await service.updateCap('p1', 't1', 'u1', 3);
    await service.stop('p1', 't1', 'u1');
    await service.publish('p1', 't1', 'u1');
    await service.sendMessage('p1', 't1', 'u1', { text: 'hi', clientMessageId: 'c1' });

    expect(threads.updateCap).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', '3', false);
    expect(threads.command).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', 'THREAD_STOP_TURN', {}, false);
    expect(threads.publish).toHaveBeenCalledWith('p1', 't1', 'u1', false);
    expect(threads.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ canOperate: false }));
  });

  it('plans another creator\'s thread as the caller when canOperate is true', async () => {
    const dispatch = vi.fn().mockResolvedValue({ job: { id: 'j1' } });
    const service = new ThreadsService(
      { get: vi.fn(async () => ({ ...record, createdById: 'someone-else', specPublished: true, runnerId: 'runner-1' })) } as unknown as ChatThreadRepository,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      { dispatch } as unknown as FleetJobsService,
      briefStub(),
    );

    await service.plan('p1', 't1', 'u1', {}, true);

    expect(dispatch).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ command: 'PLAN' }), { threadId: 't1' });
  });

  it('refuses a plan of another creator\'s thread with 403 permissions when canOperate is false', async () => {
    const dispatch = vi.fn();
    const service = new ThreadsService(
      { get: vi.fn(async () => ({ ...record, createdById: 'someone-else', specPublished: true, runnerId: 'runner-1' })) } as unknown as ChatThreadRepository,
      {} as unknown as IFleetRepoRepository,
      {} as unknown as SkillsService,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      { dispatch } as unknown as FleetJobsService,
      briefStub(),
    );

    await expect(service.plan('p1', 't1', 'u1', {})).rejects.toMatchObject({ status: 403, prefix: 'permissions' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});