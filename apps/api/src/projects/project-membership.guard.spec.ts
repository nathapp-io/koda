import type { Mock, MockInstance } from 'vitest';
/**
 * US-001 — ProjectMembershipGuard unit behaviour.
 *
 * The guard is exercised against the real ProjectAccessService, whose two collaborators are doubles:
 * a repository stub that answers only the display role (`findMembershipRole`) and a `PermissionService`
 * double that answers `project.read`. Admission and refusal (403 `projects`) therefore follow the key,
 * which is what this file's cases drive; the fake membership rows decide nothing but the role the
 * access service reports to other callers (US-004: the request no longer carries one).
 */
import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ProjectAccessService, PROJECT_ACCESS_KEY } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { ProjectMembershipGuard } from './project-membership.guard';
import { ProjectSlugFrom } from './project-slug-from.decorator';
import type { PermissionService } from '../permissions/permission.service';
import {
  AgentPrincipal,
  KodaPrincipal,
  UserPrincipal,
} from '../auth/principal/koda-principal.types';

interface MembershipRepoStub {
  findBySlug: Mock;
  findMembershipRole: Mock;
  isAgentOnRoster: Mock;
}

/**
 * Awaits a refusal and asserts it is a ForbiddenAppException. `prefix` is the
 * i18n namespace the refusal is answered with — S4c US-001 AC5 pins the agent
 * roster refusal to `projects`, the same namespace a non-member user gets.
 */
async function expectForbidden(
  promise: Promise<unknown>,
  prefix?: string,
): Promise<ForbiddenAppException> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ForbiddenAppException);
  if (prefix !== undefined) {
    expect((error as ForbiddenAppException).prefix).toBe(prefix);
  }
  return error as ForbiddenAppException;
}

/** Controller stub carrying the retired project-role metadata, set raw as a route would still be able to. */
class RetiredRoleMetadataStub {
  @SetMetadata('koda:projectRoles', ['ADMIN'])
  gated(): string {
    return 'ok';
  }
}

/** Controller stub carrying the retired permission metadata on a handler with no slug source. */
class RetiredPermissionMetadataStub {
  @SetMetadata('koda:projectPermission', { permission: ['read', 'Ticket'], exemptAgents: false })
  gated(): string {
    return 'ok';
  }
}

/** Controller stub for the code-intel read routes: slug in `?projectSlug=` (Slice 4). */
class CodeIntelRoutesStub {
  @ProjectSlugFrom('body', 'projectSlug')
  bodySlug(): string { return 'ok'; }
  @ProjectSlugFrom('query', 'projectSlug')
  searchSymbols(): string { return 'ok'; }

  withoutSlugSource(): string { return 'ok'; }

  plainRoute(): string { return 'ok'; }
}
const intel = new CodeIntelRoutesStub();

const memberUser: UserPrincipal = {
  actorType: 'user',
  id: 'user-1',
  name: 'dev@koda.dev',
  email: 'dev@koda.dev',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
  extra: {},
};

const adminUser: UserPrincipal = {
  ...memberUser,
  id: 'user-admin',
  name: 'admin@koda.dev',
  email: 'admin@koda.dev',
  role: 'ADMIN',
  authorities: ['ADMIN'],
};

const agentPrincipal: AgentPrincipal = {
  actorType: 'agent',
  id: 'agent-1',
  name: 'bot',
  slug: 'bot',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};

function makeExecutionContext(
  request: unknown,
  handler: (...args: never[]) => unknown = () => undefined,
  controller: new (...args: never[]) => unknown = class StubController {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('ProjectMembershipGuard (US-001)', () => {
  let guard: ProjectMembershipGuard;
  let access: ProjectAccessService;
  let membershipRepo: MembershipRepoStub;
  let findMembershipRoleSpy: MockInstance;

  /**
   * The catalog keys the double refuses. A case that models a caller without access to the project puts
   * `project.read` here: that refusal is what ProjectMembershipGuard answers with 403 `projects`.
   */
  let refusedKeys: ReadonlySet<string>;
  const globalReaders = new Set<string>();
  const can = vi.fn(async (principal: KodaPrincipal, key: string, ctx?: { projectId?: string }) => {
    if (key !== PROJECT_ACCESS_KEY) {
      return refusedKeys.has(key)
        ? { allowed: false, reason: 'not-granted' }
        : { allowed: true, reason: 'granted' };
    }
    if (refusedKeys.has(key)) return { allowed: false, reason: 'not-granted' };
    if (ctx?.projectId === undefined) {
      return principal.actorType === 'user' && globalReaders.has(principal.id)
        ? { allowed: true, reason: 'granted' }
        : { allowed: false, reason: 'not-granted' };
    }
    return { allowed: true, reason: 'granted' };
  });

  const activeProject = { id: 'proj-1', slug: 'alpha', deletedAt: null };

  beforeEach(() => {
    membershipRepo = { findBySlug: vi.fn(), findMembershipRole: vi.fn(), isAgentOnRoster: vi.fn() };
    refusedKeys = new Set();
    globalReaders.clear();
    access = new ProjectAccessService(
      membershipRepo as unknown as PrismaProjectRepository,
      { can } as unknown as PermissionService,
    );
    findMembershipRoleSpy = vi.spyOn(access, 'findMembershipRole');
    guard = new ProjectMembershipGuard(access, new Reflector());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    can.mockClear();
  });

  // ---------------------------------------------------------------------------
  // Permissions P1 US-004 — the guard is key-based access plus project identity
  // ---------------------------------------------------------------------------

  describe('US-004: key-based access and a role-free request context', () => {
    it('AC-1: attaches exactly { project: { id, slug } } to the request for a member', async () => {
      membershipRepo.findBySlug.mockResolvedValue(activeProject);
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const req: Record<string, unknown> = { params: { slug: 'alpha' }, user: memberUser };

      await expect(guard.canActivate(makeExecutionContext(req))).resolves.toBe(true);

      expect(req.projectContext).toEqual({ project: { id: 'proj-1', slug: 'alpha' } });
    });

    it('AC-2: ignores retired koda:projectRoles metadata, so a VIEWER member is admitted', async () => {
      membershipRepo.findBySlug.mockResolvedValue(activeProject);
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      const handler = RetiredRoleMetadataStub.prototype.gated;
      // The fixture really carries the retired key: otherwise this case would pass by accident.
      expect(Reflect.getMetadata('koda:projectRoles', handler)).toEqual(['ADMIN']);

      await expect(
        guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }, handler, RetiredRoleMetadataStub)),
      ).resolves.toBe(true);
    });

    it('AC-3: ignores retired koda:projectPermission metadata and a missing slug source, resolving true with no project lookup', async () => {
      const findProjectIdBySlugSpy = vi.spyOn(access, 'findProjectIdBySlug');
      const handler = RetiredPermissionMetadataStub.prototype.gated;
      expect(Reflect.getMetadata('koda:projectPermission', handler)).toBeDefined();

      const req: Record<string, unknown> = { params: undefined, user: memberUser };
      await expect(
        guard.canActivate(makeExecutionContext(req, handler, RetiredPermissionMetadataStub)),
      ).resolves.toBe(true);

      expect(findProjectIdBySlugSpy).not.toHaveBeenCalled();
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
      expect(req.projectContext).toBeUndefined();
    });

    it('AC-4: rejects with the access refusal and leaves projectContext unset', async () => {
      membershipRepo.findBySlug.mockResolvedValue(activeProject);
      refusedKeys = new Set([PROJECT_ACCESS_KEY]);
      const req: Record<string, unknown> = { params: { slug: 'alpha' }, user: memberUser };

      const error = await expectForbidden(guard.canActivate(makeExecutionContext(req)), 'projects');

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(req.projectContext).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // AC1 — member of the project is admitted
  // ---------------------------------------------------------------------------

  it('AC1: returns true when params.slug resolves to a project the user principal is a member of', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }),
    );

    expect(result).toBe(true);
    expect(membershipRepo.findMembershipRole).toHaveBeenCalledWith('proj-1', 'user-1');
  });

  it('AC1 boundary: returns true for a VIEWER member on a plain route (the display role gates no route)', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }),
    );

    expect(result).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC2 — a user principal without project.read is refused
  // ---------------------------------------------------------------------------

  it('AC2: throws a projects-scoped ForbiddenAppException when project.read is refused in the project', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    await expectForbidden(
      guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser })),
      'projects',
    );
    // Refused before any display-role read.
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  it('AC2 boundary: a membership row\'s role value does not decide admission on its own', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    // A stored role the legacy allow-list accepted: the caller is refused all the same, and the row is never
    // read — `project.read` is the decision, `findMembershipRole` only supplies the display role after admission.
    membershipRepo.findMembershipRole.mockResolvedValue('ADMIN');
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    await expectForbidden(
      guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser })),
      'projects',
    );
    expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC3 — agents are decided by project.read (S4c US-001 reach, US-001 gate)
  // ---------------------------------------------------------------------------

  it('AC3: returns true for an agent principal holding project.read, without a roster lookup', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.isAgentOnRoster.mockResolvedValue(false);

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: agentPrincipal }),
    );

    expect(result).toBe(true);
    expect(can).toHaveBeenCalledWith(agentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
    expect(membershipRepo.isAgentOnRoster).not.toHaveBeenCalled();
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  it('AC3 boundary: throws a projects-scoped ForbiddenAppException for an agent without project.read', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.isAgentOnRoster.mockResolvedValue(true);
    refusedKeys = new Set([PROJECT_ACCESS_KEY]);

    await expectForbidden(
      guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: agentPrincipal })),
      'projects',
    );
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC4 — global ADMIN users bypass the membership gate
  // ---------------------------------------------------------------------------

  it('AC1: admits a global reader with MEMBER role and no membership row', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue(null);
    globalReaders.add(memberUser.id);

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }),
    );

    expect(result).toBe(true);
    expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY);
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  it('AC2: refuses an ADMIN claim outside globalReaders', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    globalReaders.clear();

    await expect(can(adminUser, PROJECT_ACCESS_KEY)).resolves.toMatchObject({ allowed: false });
  });

  // ---------------------------------------------------------------------------
  // AC5 — unknown or soft-deleted project
  // ---------------------------------------------------------------------------

  it('AC5: throws NotFoundAppException when params.slug names a soft-deleted project', async () => {
    membershipRepo.findBySlug.mockResolvedValue({
      ...activeProject,
      deletedAt: new Date(),
    });

    await expect(
      guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser })),
    ).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('AC5 boundary: throws NotFoundAppException when params.slug names an unknown project', async () => {
    membershipRepo.findBySlug.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        makeExecutionContext({ params: { slug: 'no-such-project' }, user: memberUser }),
      ),
    ).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('AC5 boundary: a soft-deleted project is not reported as a membership failure', async () => {
    membershipRepo.findBySlug.mockResolvedValue({ ...activeProject, deletedAt: new Date() });

    let caught: unknown;
    try {
      await guard.canActivate(
        makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NotFoundAppException);
    expect(caught).not.toBeInstanceOf(ForbiddenAppException);
  });

  // ---------------------------------------------------------------------------
  // AC6 — routes without :slug are not gated here
  // ---------------------------------------------------------------------------

  it('AC6: returns true without calling ProjectAccessService when params.slug is absent', async () => {
    const findProjectIdBySlugSpy = vi.spyOn(access, 'findProjectIdBySlug');
    const assertProjectMembershipSpy = vi.spyOn(access, 'assertProjectMembership');

    const result = await guard.canActivate(
      makeExecutionContext({ params: { id: 'ticket-1' }, user: memberUser }),
    );

    expect(result).toBe(true);
    expect(findProjectIdBySlugSpy).not.toHaveBeenCalled();
    expect(assertProjectMembershipSpy).not.toHaveBeenCalled();
    expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
  });

  it('AC6 boundary: returns true when the request has no params object at all', async () => {
    const findProjectIdBySlugSpy = vi.spyOn(access, 'findProjectIdBySlug');

    const result = await guard.canActivate(makeExecutionContext({ user: memberUser }));

    expect(result).toBe(true);
    expect(findProjectIdBySlugSpy).not.toHaveBeenCalled();
  });

  describe('ProjectMembershipGuard - slug sources', () => {
    let slugGuard: ProjectMembershipGuard;
    beforeEach(() => {
      slugGuard = new ProjectMembershipGuard(access, new Reflector());
      membershipRepo.findBySlug.mockResolvedValue({ id: 'p1', slug: 'p1', deletedAt: null });
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
    });

    const request = (body: unknown, params: Record<string, unknown> = {}, query: Record<string, unknown> = {}) => ({
      params, query, body, user: memberUser,
    });
    const activate = (req: object, handler: () => string) =>
      slugGuard.canActivate(makeExecutionContext(req, handler, CodeIntelRoutesStub));

    it('US-001 AC-9: resolves body slug and attaches project context for an accessible project', async () => {
      const req = request({ projectSlug: 'p1' });
      await expect(activate(req, CodeIntelRoutesStub.prototype.bodySlug)).resolves.toBe(true);
      expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'p1' } });
    });

    it('US-001 AC-10: unknown body slug returns project 404', async () => {
      membershipRepo.findBySlug.mockResolvedValue(null);
      await expect(activate(request({ projectSlug: 'no-such-project' }), CodeIntelRoutesStub.prototype.bodySlug))
        .rejects.toMatchObject({ prefix: 'projects', httpStatus: 404 });
    });

    it.each([['empty', {}], ['non-string', { projectSlug: 42 }]])('US-001 AC-11/12: %s body slug is absent', async (_label, body) => {
      const req = request(body);
      await expect(activate(req, CodeIntelRoutesStub.prototype.bodySlug)).resolves.toBe(true);
      expect(req.projectContext).toBeUndefined();
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('US-001 AC-13: query slug resolution remains supported', async () => {
      const req = request({}, {}, { projectSlug: 'p1' });
      await expect(activate(req, CodeIntelRoutesStub.prototype.searchSymbols)).resolves.toBe(true);
      expect(req.projectContext?.project.id).toBe('p1');
    });

    it('US-001 AC-14: params slug takes precedence over body slug', async () => {
      const req = request({ projectSlug: 'p2' }, { slug: 'p1' });
      await expect(activate(req, CodeIntelRoutesStub.prototype.bodySlug)).resolves.toBe(true);
      expect(membershipRepo.findBySlug).toHaveBeenCalledWith('p1');
    });
  });

  describe('ProjectMembershipGuard - query slug (Track 3 Slice 4)', () => {
    let slugGuard: ProjectMembershipGuard;

    beforeEach(() => {
      slugGuard = new ProjectMembershipGuard(access, new Reflector());
      membershipRepo.findBySlug.mockResolvedValue({ id: 'p1', slug: 'team', deletedAt: null });
    });

    const run = (query: Record<string, unknown>, handler = intel.searchSymbols, user: KodaPrincipal = memberUser) => {
      const req: Record<string, unknown> = { params: {}, query, user };
      return { req, result: slugGuard.canActivate(makeExecutionContext(req, handler, CodeIntelRoutesStub)) };
    };

    it('resolves the project from the opted-in query key and admits a member', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      const { req, result } = run({ projectSlug: 'team' });
      await expect(result).resolves.toBe(true);
      expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'team' } });
    });

    it('refuses a caller without project.read in the project', async () => {
      refusedKeys = new Set([PROJECT_ACCESS_KEY]);
      await expect(run({ projectSlug: 'team' }).result).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('refuses a caller for a project that does not exist', async () => {
      membershipRepo.findBySlug.mockResolvedValue(null);
      await expect(run({ projectSlug: 'team' }).result).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it.each([
      ['missing', {}],
      ['empty', { projectSlug: '' }],
      ['repeated', { projectSlug: ['team', 'other'] }],
    ])('treats a %s projectSlug as no slug: resolves true without looking the project up', async (_label, query) => {
      const { req, result } = run(query);
      await expect(result).resolves.toBe(true);
      expect(req.projectContext).toBeUndefined();
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('ignores the query on routes that did not opt in', async () => {
      await expect(run({ projectSlug: 'team' }, intel.withoutSlugSource).result).resolves.toBe(true);
      await expect(run({ projectSlug: 'team' }, intel.plainRoute).result).resolves.toBe(true);
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('prefers params.slug over the query', async () => {
      const req: Record<string, unknown> = { params: { slug: 'team' }, query: { projectSlug: 'elsewhere' }, user: memberUser };
      await expect(slugGuard.canActivate(makeExecutionContext(req, intel.searchSymbols, CodeIntelRoutesStub))).resolves.toBe(true);
      expect(membershipRepo.findBySlug.mock.calls[0][0]).toBe('team');
    });
  });
});
