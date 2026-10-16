import { WorkspaceThreadsService } from './workspace-threads.service';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ChatThreadRepository } from './domain/chat-thread.domain';
import type { IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import type { SkillsService } from '../../skills/skills.service';
import type { ProjectsService } from '../../projects/projects.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import type { IFleetConfig } from '../../config/fleet.config';

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
      new KodaCaslAbilityFactory(),
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
