import { WorkspaceThreadsService } from './workspace-threads.service';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { PermissionService } from '../../permissions/permission.service';
import type { PermissionDecision } from '../../permissions/permissions.types';
import type { ChatThreadRepository } from './domain/chat-thread.domain';
import type { IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import type { SkillsService } from '../../skills/skills.service';
import type { ProjectsService } from '../../projects/projects.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import type { IFleetConfig } from '../../config/fleet.config';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';
import { AfterCommitService } from '../../permissions/after-commit.service';
import { Logger } from '@nestjs/common';

const allow = (): PermissionDecision => ({ allowed: true, reason: 'granted' });
const deny = (reason: PermissionDecision['reason'] = 'not-granted'): PermissionDecision => ({ allowed: false, reason });

/**
 * US-003: the home project is chosen by the `thread.create` key (`canHost`), not by the CASL
 * `CREATE FleetJob` ability, and an agent's default home skips a project it is not on the roster of.
 */
describe('workspace home project creation', () => {
  const a = { id: 'a', slug: 'a', name: 'A', createdAt: new Date(1000) };
  const b = { id: 'b', slug: 'b', name: 'B', createdAt: new Date(2000) };
  let principal: UserPrincipal;
  let roles: Record<string, string | null>;
  /** Projects whose `thread.create` the stub refuses. */
  let refused: Set<string>;
  /** Projects whose roster does not carry the agent the stub is asked about. */
  let offRoster: Set<string>;
  let reachable: typeof a[];
  let anchors: Set<string>;
  let config: { threadsEnabled: boolean };
  let create: ReturnType<typeof vi.fn>;
  let can: ReturnType<typeof vi.fn>;
  let resolveMembership: ReturnType<typeof vi.fn>;
  let service: WorkspaceThreadsService;
  let snapshot: ReturnType<typeof vi.fn>;
  const input = { title: 't', backend: { kind: 'native' as const } };

  /** `resolveMembership`'s refusal for an agent that is not on the project's roster. */
  const resolveMembershipFor = (id: string): Promise<string | null> => offRoster.has(id)
    ? Promise.reject(new ForbiddenAppException({}, 'projects')) : Promise.resolve(null);

  beforeEach(() => {
    principal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@example.com' };
    roles = { a: 'DEVELOPER', b: 'DEVELOPER' }; refused = new Set(); offRoster = new Set(); reachable = [b, a]; anchors = new Set(['a', 'b']); config = { threadsEnabled: true };
    create = vi.fn(async (value) => ({ id: 'thread', ...value })); snapshot = vi.fn(async () => []);
    // US-003: the host decision is the `thread.create` key; a project listed in `refused` lacks it.
    can = vi.fn(async (_principal: unknown, _key: string, ctx?: { projectId?: string }) => (refused.has(ctx?.projectId ?? '') ? deny() : allow()));
    resolveMembership = vi.fn(resolveMembershipFor);
    service = new WorkspaceThreadsService(
      { create } as unknown as ChatThreadRepository,
      { findAnchor: vi.fn(async (id: string) => anchors.has(id) ? { id: 'repo' } : null) } as unknown as IFleetRepoRepository,
      { snapshotForProject: snapshot } as unknown as SkillsService,
      config as IFleetConfig,
      { findAllForPrincipal: vi.fn(async () => reachable) } as unknown as ProjectsService,
      { findMembershipRole: vi.fn(async (id: string) => roles[id] ?? null), resolveMembership } as unknown as ProjectAccessService,
      { can } as unknown as PermissionService,
      {} as never,
      new AfterCommitService(),
    );
  });

  it('AC-6/7: chooses oldest home and persists WORKSPACE with null repo fields', async () => {
    expect(await service.create(principal, input)).toMatchObject({ kind: 'WORKSPACE', projectId: 'a', homeProject: { slug: 'a', name: 'A' } });
    expect(create).toHaveBeenCalledWith({ kind: 'WORKSPACE', projectId: 'a', repoId: null, feature: null, baseRef: null, title: 't', createdById: 'u', backend: input.backend, skills: [], maxCostUsd: '5' });
    expect(snapshot).toHaveBeenCalledWith('a');
  });
  it('AC-8: skips projects without repos', async () => { anchors.delete('a'); expect(await service.create(principal, input)).toMatchObject({ projectId: 'b' }); });
  it('AC-9: skips a project whose thread.create key is refused', async () => { refused.add('a'); expect(await service.create(principal, input)).toMatchObject({ projectId: 'b' }); });
  it('AC-10: admin default requires actual membership', async () => { principal.role = 'ADMIN'; roles = {}; await expect(service.create(principal, input)).rejects.toMatchObject({ prefix: 'threads.noFleetRepo', httpStatus: 409 }); expect(create).not.toHaveBeenCalled(); });
  it('AC-11: explicit home whose thread.create key is refused answers 403 permissions', async () => { refused.add('a'); await expect(service.create(principal, { ...input, homeProject: 'a' })).rejects.toMatchObject({ prefix: 'permissions', httpStatus: 403 }); expect(create).not.toHaveBeenCalled(); });
  it('AC-12: explicit home needs a repo', async () => { anchors.delete('a'); await expect(service.create(principal, { ...input, homeProject: 'a' })).rejects.toMatchObject({ prefix: 'threads.noFleetRepo', httpStatus: 409 }); });
  it.each(['AC-13', 'AC-14'])('%s: unreachable and unknown homes are identical', async () => { reachable = [b]; await expect(service.create(principal, { ...input, homeProject: 'a' })).rejects.toMatchObject({ prefix: 'projects', httpStatus: 404 }); });
  it('AC-15: kill switch precedes validation', async () => { config.threadsEnabled = false; await expect(service.create(principal, { ...input, kind: 'PROJECT' })).rejects.toMatchObject({ prefix: 'threads.disabled', httpStatus: 409 }); });
  it('breaks createdAt ties by id', async () => { reachable = [b, { ...a, createdAt: b.createdAt }]; expect(await service.create(principal, input)).toMatchObject({ projectId: 'a' }); });
  it('explicit admin home need not have a membership row', async () => { principal.role = 'ADMIN'; roles = {}; expect(await service.create(principal, { ...input, homeProject: 'b' })).toMatchObject({ projectId: 'b' }); });

  describe('US-003 default home selection', () => {
    /** US-003 AC-10: p1 is reachable but its `thread.create` is refused; p2 has it, and both have an anchor. */
    it('AC-10: homes the thread in the first reachable project whose thread.create key is allowed', async () => {
      refused.add('a');

      const thread = await service.create(principal, input);

      expect(thread).toMatchObject({ projectId: 'b', homeProject: { slug: 'b', name: 'B' } });
      // The host decision is the key, in each candidate project, oldest first.
      expect(can.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ['thread.create', { projectId: 'a' }],
        ['thread.create', { projectId: 'b' }],
      ]);
    });

    it('homes an agent in a project it is rostered in, skipping one it is not', async () => {
      const agent: AgentPrincipal = { actorType: 'agent', id: 'ag', slug: 'ag', status: 'ACTIVE', agentRoles: [], capabilities: [] };
      // An agent's reach can cover a project its roster does not (a `projectId`-null binding, or
      // scoping off): the membership resolve throws `projects` there and the loop skips that project,
      // even though its `thread.create` key is held.
      offRoster.add('a');

      expect(await service.create(agent, input)).toMatchObject({ projectId: 'b' });
      expect(resolveMembership.mock.calls).toEqual([['a', agent], ['b', agent]]);
      // The skip came from the roster, not from the key: nothing asked `thread.create` in `a`.
      expect(can.mock.calls.map((call) => call[2])).toEqual([{ projectId: 'b' }]);
      // A user keeps the legacy `ProjectMember` read instead.
      expect(roles).toEqual({ a: 'DEVELOPER', b: 'DEVELOPER' });
    });

    it('answers the agent error unchanged when no reachable project hosts the thread', async () => {
      const agent: AgentPrincipal = { actorType: 'agent', id: 'ag', slug: 'ag', status: 'ACTIVE', agentRoles: [], capabilities: [] };
      refused.add('a'); refused.add('b');

      await expect(service.create(agent, input)).rejects.toMatchObject({ prefix: 'threads.noFleetRepo', httpStatus: 409 });
      expect(create).not.toHaveBeenCalled();
    });
  });
});

/**
 * US-004: every read, cap write and command goes through the workspace scope, so the HTTP layer never
 * names a project (1d-D2 creator-only, 1d-D10 thread scope).
 *
 * US-003 adds the service-level half of the four S routes: each loads the caller's own thread, then
 * asks the project key of the thread's home project with the thread's creator as the resource.
 */
describe('workspace read, cap and command scope', () => {
  const record = {
    id: 't1', kind: 'WORKSPACE' as const, projectId: 'p1', createdById: 'u',
    homeProject: { slug: 'web', name: 'Web' }, maxCostUsd: '5',
  };
  let repository: Record<'list' | 'get' | 'sendRefusalOf' | 'handoff' | 'pendingActions' | 'messages' | 'updateCap' | 'command', ReturnType<typeof vi.fn>>;
  let can: ReturnType<typeof vi.fn>;
  let config: { threadsEnabled: boolean };
  let principal: UserPrincipal;
  let service: WorkspaceThreadsService;

  beforeEach(() => {
    repository = {
      list: vi.fn(async () => [record]), get: vi.fn(async () => record), sendRefusalOf: vi.fn(async () => null),
      handoff: vi.fn(async () => ({ plan: null, run: null })), pendingActions: vi.fn(async () => []),
      messages: vi.fn(async () => [{ id: 'm1', seq: 1 }]),
      updateCap: vi.fn(async () => record), command: vi.fn(async () => undefined),
    };
    config = { threadsEnabled: true };
    can = vi.fn(async () => allow());
    principal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@example.com' };
    service = new WorkspaceThreadsService(
      repository as unknown as ChatThreadRepository,
      {} as IFleetRepoRepository, {} as SkillsService, config as IFleetConfig, {} as ProjectsService,
      {} as ProjectAccessService, { can } as unknown as PermissionService, {} as never, new AfterCommitService(),
    );
  });

  it('AC-1/AC-3: lists through the workspace scope and reports the kill switch', async () => {
    await expect(service.list('u', 'ACTIVE', 20, 20)).resolves.toEqual({ items: [record], threadsEnabled: true });
    expect(repository.list).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 'ACTIVE', 20, 20);
  });

  it('AC-5: reads the owned thread with its send refusal and handoff', async () => {
    await expect(service.get('u', 't1')).resolves.toEqual({ ...record, sendRefusal: null, handoff: { plan: null, run: null }, pendingActions: [] });
    expect(repository.get).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1');
    // The send refusal is judged against the thread's home project.
    expect(repository.sendRefusalOf).toHaveBeenCalledWith('p1', record);
    expect(repository.handoff).toHaveBeenCalledWith('t1');
  });

  it('US-004 AC-4: the workspace detail answers the repository\'s pending actions of that thread, unchanged', async () => {
    const action = {
      id: 'ap1', approvalId: 'ap1', tool: 'koda_add_comment', preview: 'Add a comment to KODA-1 "Fix login":\n\nhello',
      projectSlug: 'ops', expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'),
    };
    repository.pendingActions.mockResolvedValue([action]);

    const thread = await service.get('u', 't1');

    expect(thread.pendingActions).toEqual([action]);
    // M1: the read is fenced by the caller's scope, never a bare thread id.
    expect(repository.pendingActions).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1');
  });

  it('AC-4/AC-6: a miss through the workspace scope answers 404 threads.notFound', async () => {
    repository.get.mockResolvedValue(null);
    await expect(service.get('u', 't1')).rejects.toMatchObject({ prefix: 'threads.notFound', httpStatus: 404 });
    expect(repository.handoff).not.toHaveBeenCalled();
  });

  it('AC-7/AC-8: reads the owned thread before its messages and refuses a miss', async () => {
    await expect(service.messages('u', 't1', 3, 100)).resolves.toEqual({ items: [{ id: 'm1', seq: 1 }] });
    expect(repository.get).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1');
    expect(repository.messages).toHaveBeenCalledWith('t1', 3, 100);
    repository.get.mockResolvedValue(null);
    await expect(service.messages('u', 't1', 0, 100)).rejects.toMatchObject({ prefix: 'threads.notFound', httpStatus: 404 });
    expect(repository.messages).toHaveBeenCalledTimes(1);
  });

  it('AC-13: writes the cap through the workspace scope and answers the home project', async () => {
    const updated = { ...record, maxCostUsd: '7', homeProject: undefined };
    repository.updateCap.mockResolvedValue(updated);
    const result = await service.updateCap(principal, 't1', 7);
    expect(repository.updateCap).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1', 'u', '7');
    expect(result).toEqual({ ...updated, homeProject: { slug: 'web', name: 'Web' } });
    expect(result).not.toBe(updated);
  });

  it('refuses a cap outside the shared bounds before touching the repository', async () => {
    await expect(service.updateCap(principal, 't1', 0)).rejects.toMatchObject({ prefix: 'threads.input', httpStatus: 400 });
    expect(repository.updateCap).not.toHaveBeenCalled();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('AC-14/AC-15: queues stop and end-session through the workspace scope', async () => {
    await service.stop(principal, 't1');
    await service.endSession(principal, 't1');
    expect(repository.command).toHaveBeenNthCalledWith(1, { kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_STOP_TURN, {});
    expect(repository.command).toHaveBeenNthCalledWith(2, { kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_CLOSE, {});
  });

  it('propagates the repository session refusal of a command', async () => {
    repository.command.mockRejectedValue(new ConflictAppException({}, 'threads.noSession'));
    await expect(service.endSession(principal, 't1')).rejects.toMatchObject({ prefix: 'threads.noSession', httpStatus: 409 });
  });

  it('answers a question through the workspace scope after validating the body', async () => {
    await service.answer(principal, 't1', { requestId: 'q1', text: 'yes' });
    expect(repository.command).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_ANSWER, { requestId: 'q1', text: 'yes' });
    await expect(service.answer(principal, 't1', { requestId: 'q1', text: '' })).rejects.toMatchObject({ prefix: 'threads.input', httpStatus: 400 });
    expect(repository.command).toHaveBeenCalledTimes(1);
  });

  /** US-003: the four S routes ask their key in the thread's home project, on the thread's creator. */
  const S_ROUTES: ReadonlyArray<{ key: string; run: (service: WorkspaceThreadsService, principal: UserPrincipal) => Promise<unknown> }> = [
    { key: 'thread.cap.update', run: (threads, who) => threads.updateCap(who, 't1', 7) },
    { key: 'thread.stop', run: (threads, who) => threads.stop(who, 't1') },
    { key: 'thread.end-session', run: (threads, who) => threads.endSession(who, 't1') },
    { key: 'thread.answer', run: (threads, who) => threads.answer(who, 't1', { requestId: 'q1', text: 'yes' }) },
  ];

  it.each(S_ROUTES)('AC-7/AC-8: $key is asked of the thread\'s home project with its creator as the resource', async ({ key, run }) => {
    await run(service, principal);

    expect(can).toHaveBeenCalledWith(principal, key, {
      projectId: 'p1',
      resource: { createdBy: { type: 'USER', id: 'u' } },
    });
  });

  it.each(S_ROUTES)('AC-7/AC-8: $key is refused with 403 permissions when the key is not held', async ({ key, run }) => {
    can.mockResolvedValue(deny());

    await expect(run(service, principal)).rejects.toMatchObject({ prefix: 'permissions', httpStatus: 403 });
    expect(repository.updateCap).not.toHaveBeenCalled();
    expect(repository.command).not.toHaveBeenCalled();
  });

  it('passes an agent creator as the AGENT principal in the key resource', async () => {
    repository.get.mockResolvedValue({ ...record, createdById: 'ag', createdByType: 'AGENT' });
    const agent: AgentPrincipal = { actorType: 'agent', id: 'ag', slug: 'ag', status: 'ACTIVE', agentRoles: [], capabilities: [] };

    await service.stop(agent, 't1');

    expect(can).toHaveBeenCalledWith(agent, 'thread.stop', {
      projectId: 'p1',
      resource: { createdBy: { type: 'AGENT', id: 'ag' } },
    });
    expect(repository.command).toHaveBeenCalledWith({ kind: 'workspace', userId: 'ag' }, 't1', 'ag', FleetCommandType.THREAD_STOP_TURN, {});
  });

  it('answers 404 for a thread the caller does not own before asking the key', async () => {
    repository.get.mockResolvedValue(null);

    for (const { run } of S_ROUTES) {
      await expect(run(service, principal)).rejects.toMatchObject({ prefix: 'threads.notFound', httpStatus: 404 });
    }
    expect(can).not.toHaveBeenCalled();
  });

  describe('archive cancel commit boundary', () => {
    let afterCommit: AfterCommitService;
    let cancel: ReturnType<typeof vi.fn>;
    let archiveService: WorkspaceThreadsService;
    let archiveRepository: Record<string, ReturnType<typeof vi.fn>>;

    beforeEach(() => {
      afterCommit = new AfterCommitService();
      cancel = vi.fn(async () => undefined);
      archiveRepository = { get: vi.fn(async () => record), archive: vi.fn(async () => 'j1') };
      archiveService = new WorkspaceThreadsService(
        archiveRepository as unknown as ChatThreadRepository, {} as IFleetRepoRepository, {} as SkillsService,
        { threadsEnabled: true } as IFleetConfig, {} as ProjectsService, {} as ProjectAccessService,
        {} as PermissionService, { cancel } as never, afterCommit,
      );
    });

    it('AC-8: defers cancellation until after the commit scope callback returns', async () => {
      const order: string[] = [];
      cancel.mockImplementation(async () => { order.push('cancel'); });
      await afterCommit.scope(async () => {
        await archiveService.archive(principal, 't1');
        order.push('scope');
        expect(order).toEqual(['scope']);
      });
      expect(order).toEqual(['scope', 'cancel']);
      expect(cancel).toHaveBeenCalledWith('u', 'p1', 'j1', true);
    });

    it('AC-10: logs a deferred cancellation failure without rejecting the committed archive', async () => {
      const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      cancel.mockRejectedValue(new Error('offline'));
      await expect(afterCommit.scope(() => archiveService.archive(principal, 't1'))).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledTimes(1);
      warning.mockRestore();
    });

    it('REG-1: cancels immediately outside an after-commit scope', async () => {
      await archiveService.archive(principal, 't1');
      expect(cancel).toHaveBeenCalledWith('u', 'p1', 'j1', true);
    });
  });
});
