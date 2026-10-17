import { WorkspaceThreadsService } from './workspace-threads.service';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ChatThreadRepository } from './domain/chat-thread.domain';
import type { IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import type { SkillsService } from '../../skills/skills.service';
import type { ProjectsService } from '../../projects/projects.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import type { IFleetConfig } from '../../config/fleet.config';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';

describe('workspace home project creation', () => {
  const a = { id: 'a', slug: 'a', name: 'A', createdAt: new Date(1000) };
  const b = { id: 'b', slug: 'b', name: 'B', createdAt: new Date(2000) };
  let principal: UserPrincipal;
  let roles: Record<string, string | null>;
  let reachable: typeof a[];
  let anchors: Set<string>;
  let config: { threadsEnabled: boolean };
  let create: ReturnType<typeof vi.fn>;
  let service: WorkspaceThreadsService;
  let snapshot: ReturnType<typeof vi.fn>;
  const input = { title: 't', backend: { kind: 'native' as const } };
  beforeEach(() => {
    principal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@example.com' };
    roles = { a: 'DEVELOPER', b: 'DEVELOPER' }; reachable = [b, a]; anchors = new Set(['a', 'b']); config = { threadsEnabled: true };
    create = vi.fn(async (value) => ({ id: 'thread', ...value })); snapshot = vi.fn(async () => []);
    service = new WorkspaceThreadsService(
      { create } as unknown as ChatThreadRepository,
      { findAnchor: vi.fn(async (id: string) => anchors.has(id) ? { id: 'repo' } : null) } as unknown as IFleetRepoRepository,
      { snapshotForProject: snapshot } as unknown as SkillsService,
      config as IFleetConfig,
      { findAllForPrincipal: vi.fn(async () => reachable) } as unknown as ProjectsService,
      { findMembershipRole: vi.fn(async (id: string) => roles[id] ?? null), resolveMembership: vi.fn(async (id: string) => principal.role === 'ADMIN' ? 'ADMIN' : roles[id]) } as unknown as ProjectAccessService,
      new KodaCaslAbilityFactory(), {} as never,
    );
  });
  it('AC-6/7: chooses oldest home and persists WORKSPACE with null repo fields', async () => {
    expect(await service.create(principal, input)).toMatchObject({ kind: 'WORKSPACE', projectId: 'a', homeProject: { slug: 'a', name: 'A' } });
    expect(create).toHaveBeenCalledWith({ kind: 'WORKSPACE', projectId: 'a', repoId: null, feature: null, baseRef: null, title: 't', createdById: 'u', backend: input.backend, skills: [], maxCostUsd: '5' });
    expect(snapshot).toHaveBeenCalledWith('a');
  });
  it('AC-8: skips projects without repos', async () => { anchors.delete('a'); expect(await service.create(principal, input)).toMatchObject({ projectId: 'b' }); });
  it('AC-9: skips VIEWER projects', async () => { roles.a = 'VIEWER'; expect(await service.create(principal, input)).toMatchObject({ projectId: 'b' }); });
  it('AC-10: admin default requires actual membership', async () => { principal.role = 'ADMIN'; roles = {}; await expect(service.create(principal, input)).rejects.toMatchObject({ prefix: 'threads.noFleetRepo', httpStatus: 409 }); expect(create).not.toHaveBeenCalled(); });
  it('AC-11: explicit VIEWER home is forbidden', async () => { roles.a = 'VIEWER'; await expect(service.create(principal, { ...input, homeProject: 'a' })).rejects.toMatchObject({ prefix: 'threads.homeProjectAccess', httpStatus: 403 }); });
  it('AC-12: explicit home needs a repo', async () => { anchors.delete('a'); await expect(service.create(principal, { ...input, homeProject: 'a' })).rejects.toMatchObject({ prefix: 'threads.noFleetRepo', httpStatus: 409 }); });
  it.each(['AC-13', 'AC-14'])('%s: unreachable and unknown homes are identical', async () => { reachable = [b]; await expect(service.create(principal, { ...input, homeProject: 'a' })).rejects.toMatchObject({ prefix: 'projects', httpStatus: 404 }); });
  it('AC-15: kill switch precedes validation', async () => { config.threadsEnabled = false; await expect(service.create(principal, { ...input, kind: 'PROJECT' })).rejects.toMatchObject({ prefix: 'threads.disabled', httpStatus: 409 }); });
  it('breaks createdAt ties by id', async () => { reachable = [b, { ...a, createdAt: b.createdAt }]; expect(await service.create(principal, input)).toMatchObject({ projectId: 'a' }); });
  it('explicit admin home need not have a membership row', async () => { principal.role = 'ADMIN'; roles = {}; expect(await service.create(principal, { ...input, homeProject: 'b' })).toMatchObject({ projectId: 'b' }); });
});

/**
 * US-004: every read, cap write and command goes through the workspace scope, so the HTTP layer never
 * names a project (1d-D2 creator-only, 1d-D10 thread scope).
 */
describe('workspace read, cap and command scope', () => {
  const record = { id: 't1', kind: 'WORKSPACE' as const, projectId: 'p1', createdById: 'u', homeProject: { slug: 'web', name: 'Web' }, maxCostUsd: '5' };
  let repository: Record<'list' | 'get' | 'sendRefusalOf' | 'handoff' | 'pendingActions' | 'messages' | 'updateCap' | 'command', ReturnType<typeof vi.fn>>;
  let config: { threadsEnabled: boolean };
  let service: WorkspaceThreadsService;

  beforeEach(() => {
    repository = {
      list: vi.fn(async () => [record]), get: vi.fn(async () => record), sendRefusalOf: vi.fn(async () => null),
      handoff: vi.fn(async () => ({ plan: null, run: null })), pendingActions: vi.fn(async () => []),
      messages: vi.fn(async () => [{ id: 'm1', seq: 1 }]),
      updateCap: vi.fn(async () => record), command: vi.fn(async () => undefined),
    };
    config = { threadsEnabled: true };
    service = new WorkspaceThreadsService(
      repository as unknown as ChatThreadRepository,
      {} as IFleetRepoRepository, {} as SkillsService, config as IFleetConfig, {} as ProjectsService, {} as ProjectAccessService, new KodaCaslAbilityFactory(), {} as never,
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
      id: 'a1', approvalId: 'ap1', tool: 'koda_add_comment', preview: 'Add a comment to KODA-1 "Fix login":\n\nhello',
      projectSlug: 'ops', expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'),
    };
    repository.pendingActions.mockResolvedValue([action]);

    const thread = await service.get('u', 't1');

    expect(thread.pendingActions).toEqual([action]);
    expect(repository.pendingActions).toHaveBeenCalledWith('t1');
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
    repository.get.mockResolvedValue({ ...record, maxCostUsd: '7' });
    const result = await service.updateCap('u', 't1', 7);
    expect(repository.updateCap).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1', 'u', '7');
    expect(result).toEqual({ ...updated, homeProject: { slug: 'web', name: 'Web' } });
    expect(result).not.toBe(updated);
  });

  it('refuses a cap outside the shared bounds before touching the repository', async () => {
    await expect(service.updateCap('u', 't1', 0)).rejects.toMatchObject({ prefix: 'threads.input', httpStatus: 400 });
    expect(repository.updateCap).not.toHaveBeenCalled();
  });

  it('AC-14/AC-15: queues stop and end-session through the workspace scope', async () => {
    await service.stop('u', 't1');
    await service.endSession('u', 't1');
    expect(repository.command).toHaveBeenNthCalledWith(1, { kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_STOP_TURN, {});
    expect(repository.command).toHaveBeenNthCalledWith(2, { kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_CLOSE, {});
  });

  it('propagates the repository session refusal of a command', async () => {
    repository.command.mockRejectedValue(new ConflictAppException({}, 'threads.noSession'));
    await expect(service.endSession('u', 't1')).rejects.toMatchObject({ prefix: 'threads.noSession', httpStatus: 409 });
  });

  it('answers a question through the workspace scope after validating the body', async () => {
    await service.answer('u', 't1', { requestId: 'q1', text: 'yes' });
    expect(repository.command).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_ANSWER, { requestId: 'q1', text: 'yes' });
    await expect(service.answer('u', 't1', { requestId: 'q1', text: '' })).rejects.toMatchObject({ prefix: 'threads.input', httpStatus: 400 });
    expect(repository.command).toHaveBeenCalledTimes(1);
  });
});
