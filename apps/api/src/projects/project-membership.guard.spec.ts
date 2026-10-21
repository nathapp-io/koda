import type { Mock, MockInstance } from 'vitest';
/**
 * US-001 — ProjectMembershipGuard unit behaviour.
 *
 * The guard is exercised against the real ProjectAccessService, whose two collaborators are doubles:
 * a repository stub that answers only the display role (`findMembershipRole`) and a `PermissionService`
 * double that answers `project.read`. Admission and refusal (403 `projects`) therefore follow the key,
 * which is what this file's cases drive; the fake membership rows decide nothing but the role the guard
 * attaches to the request.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { ProjectAccessService, PROJECT_ACCESS_KEY } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { ProjectMembershipGuard } from './project-membership.guard';
import { ProjectRoles } from './project-roles.decorator';
import { ProjectPermission } from './project-permission.decorator';
import { ProjectSlugFrom } from './project-slug-from.decorator';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
import { KodaAction } from '../auth/casl/koda-action.enum';
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

/** Controller stub carrying @ProjectRoles on a handler, as the KB write routes do. */
class KbWriteRouteStub {
  @ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')
  addDocument(): string {
    return 'indexed';
  }
}

/** Controller stub carrying @ProjectRoles on the class, as a class-level KB gate would. */
@ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')
class KbClassRolesStub {
  listDocuments(): string {
    return 'listed';
  }
}

/** Controller stub carrying @ProjectPermission, as the ticket/label routes do (#144). */
class TicketRoutesStub {
  @ProjectPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  transition(): string { return 'ok'; }

  @ProjectPermission([CaslPermissionAction.DELETE, 'Ticket'])
  remove(): string { return 'ok'; }

  @ProjectPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'], { exemptAgents: true })
  assignLabel(): string { return 'ok'; }
}
const routes = new TicketRoutesStub();

/** Controller stub for the code-intel read routes: slug in `?projectSlug=` (Slice 4). */
class CodeIntelRoutesStub {
  @ProjectSlugFrom('body', 'projectSlug')
  bodySlug(): string { return 'ok'; }
  @ProjectSlugFrom('query', 'projectSlug')
  @ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])
  searchSymbols(): string { return 'ok'; }

  @ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])
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
  const can = vi.fn(async (principal: KodaPrincipal, key: string, ctx?: { projectId?: string }) => {
    if (key !== PROJECT_ACCESS_KEY) {
      return refusedKeys.has(key)
        ? { allowed: false, reason: 'not-granted' }
        : { allowed: true, reason: 'granted' };
    }
    if (refusedKeys.has(key)) return { allowed: false, reason: 'not-granted' };
    // The global ask is what a global Owner/Admin holds: with the seeded roles that is exactly what the
    // legacy `User.role = 'ADMIN'` claim resolves to (`PermissionService.isLegacyAdmin`).
    if (ctx?.projectId === undefined) {
      return principal.actorType === 'user' && principal.role === 'ADMIN'
        ? { allowed: true, reason: 'granted' }
        : { allowed: false, reason: 'not-granted' };
    }
    return { allowed: true, reason: 'granted' };
  });

  const activeProject = { id: 'proj-1', slug: 'alpha', deletedAt: null };

  beforeEach(() => {
    membershipRepo = { findBySlug: vi.fn(), findMembershipRole: vi.fn(), isAgentOnRoster: vi.fn() };
    refusedKeys = new Set();
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

  it('AC1 boundary: returns true for a VIEWER member on a route without @ProjectRoles (the project role gates visibility only)', async () => {
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

  it('AC2 boundary: the membership row\'s role value no longer decides admission', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    // A role string the legacy allow-list rejected: the key, not the row, is the decision.
    membershipRepo.findMembershipRole.mockResolvedValue('GUEST');

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }),
    );

    expect(result).toBe(true);
    expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
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

  it('AC4: returns true for a global ADMIN user with no membership row', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: adminUser }),
    );

    expect(result).toBe(true);
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------------
  // AC15 / AC16 — @ProjectRoles applied to a handler
  // ---------------------------------------------------------------------------

  it('AC15: returns true for an agent principal holding project.read on a handler carrying @ProjectRoles without calling findMembershipRole', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);

    const result = await guard.canActivate(
      makeExecutionContext(
        { params: { slug: 'alpha' }, user: agentPrincipal },
        KbWriteRouteStub.prototype.addDocument,
        KbWriteRouteStub,
      ),
    );

    expect(result).toBe(true);
    expect(can).toHaveBeenCalledWith(agentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'proj-1' });
    expect(findMembershipRoleSpy).not.toHaveBeenCalled();
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  it('AC16: returns true for a global ADMIN user on a handler carrying @ProjectRoles without calling findMembershipRole', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);

    const result = await guard.canActivate(
      makeExecutionContext(
        { params: { slug: 'alpha' }, user: adminUser },
        KbWriteRouteStub.prototype.addDocument,
        KbWriteRouteStub,
      ),
    );

    expect(result).toBe(true);
    expect(findMembershipRoleSpy).not.toHaveBeenCalled();
    expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
  });

  it('AC16 boundary: allows a member whose project role is in @ProjectRoles', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');

    const result = await guard.canActivate(
      makeExecutionContext(
        { params: { slug: 'alpha' }, user: memberUser },
        KbWriteRouteStub.prototype.addDocument,
        KbWriteRouteStub,
      ),
    );

    expect(result).toBe(true);
    expect(membershipRepo.findMembershipRole).toHaveBeenCalledWith('proj-1', 'user-1');
  });

  it('AC12: throws ForbiddenAppException for a member whose project role is VIEWER on a @ProjectRoles write handler', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');

    await expect(
      guard.canActivate(
        makeExecutionContext(
          { params: { slug: 'alpha' }, user: memberUser },
          KbWriteRouteStub.prototype.addDocument,
          KbWriteRouteStub,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('AC12 boundary: throws ForbiddenAppException when the membership row is missing on a @ProjectRoles handler', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        makeExecutionContext(
          { params: { slug: 'alpha' }, user: memberUser },
          KbWriteRouteStub.prototype.addDocument,
          KbWriteRouteStub,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('AC16 boundary: reads @ProjectRoles from the controller class when the handler carries none', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');

    await expect(
      guard.canActivate(
        makeExecutionContext(
          { params: { slug: 'alpha' }, user: memberUser },
          KbClassRolesStub.prototype.listDocuments,
          KbClassRolesStub,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('AC16 boundary: leaves routes without @ProjectRoles ungated by project role', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser }),
    );

    expect(result).toBe(true);
    expect(findMembershipRoleSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #144/#145 — ProjectContext and @ProjectPermission
  // ---------------------------------------------------------------------------

  describe('ProjectMembershipGuard - ProjectContext and @ProjectPermission (#144/#145)', () => {
    let guardWithCasl: ProjectMembershipGuard;

    beforeEach(() => {
      guardWithCasl = new ProjectMembershipGuard(access, new Reflector(), new KodaCaslAbilityFactory());
      membershipRepo.findBySlug.mockResolvedValue({ id: 'p1', slug: 'team', deletedAt: null });
      // US-001: agents reach the project through `project.read`; the legacy roster read is not consulted.
      membershipRepo.isAgentOnRoster.mockResolvedValue(true);
    });

    it('attaches ProjectContext with the membership role, querying membership exactly once', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const req: Record<string, unknown> = { params: { slug: 'team' }, user: memberUser };
      await expect(guardWithCasl.canActivate(makeExecutionContext(req, routes.transition, TicketRoutesStub))).resolves.toBe(true);
      expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'team' }, role: 'DEVELOPER' });
      expect(membershipRepo.findMembershipRole).toHaveBeenCalledTimes(1);
    });

    it('refuses a VIEWER on a TRANSITION route before the handler runs', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      const req = { params: { slug: 'team' }, user: memberUser };
      await expect(guardWithCasl.canActivate(makeExecutionContext(req, routes.transition, TicketRoutesStub)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('refuses a DEVELOPER on DELETE Ticket and allows a project ADMIN', async () => {
      membershipRepo.findMembershipRole.mockResolvedValueOnce('DEVELOPER').mockResolvedValueOnce('ADMIN');
      const ctx = () => makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, routes.remove, TicketRoutesStub);
      await expect(guardWithCasl.canActivate(ctx())).rejects.toBeInstanceOf(ForbiddenAppException);
      await expect(guardWithCasl.canActivate(ctx())).resolves.toBe(true);
    });

    it('evaluates agents with their agent-role ability, exactly as @RequiredPermission did', async () => {
      const reviewer = { ...agentPrincipal, agentRoles: ['REVIEWER'] as const };
      const noTransition = { ...agentPrincipal, agentRoles: ['TRIAGER'] as const };
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: reviewer }, routes.transition, TicketRoutesStub))).resolves.toBe(true);
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: noTransition }, routes.transition, TicketRoutesStub)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
      expect(membershipRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('exemptAgents skips the permission for agents but still enforces it for users', async () => {
      const triager = { ...agentPrincipal, agentRoles: [] as const };
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: triager }, routes.assignLabel, TicketRoutesStub))).resolves.toBe(true);
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, routes.assignLabel, TicketRoutesStub)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('fails closed when a @ProjectPermission route has no :slug param', async () => {
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: {}, user: memberUser }, routes.transition, TicketRoutesStub)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('fails closed on a @ProjectPermission route when no ability factory is wired', async () => {
      const bare = new ProjectMembershipGuard(access, new Reflector());
      membershipRepo.findMembershipRole.mockResolvedValue('ADMIN');
      await expect(bare.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, routes.transition, TicketRoutesStub)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('ignores a projectRole already on the principal (e.g. a forged claim)', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      const forged = { ...memberUser, projectRole: 'ADMIN' };
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: forged }, routes.remove, TicketRoutesStub)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('a @ProjectRoles route reads the resolved role without a second membership query', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const kb = new KbWriteRouteStub();
      await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, kb.addDocument, KbWriteRouteStub))).resolves.toBe(true);
      expect(membershipRepo.findMembershipRole).toHaveBeenCalledTimes(1);
    });
  });

  describe('ProjectMembershipGuard - slug sources', () => {
    let slugGuard: ProjectMembershipGuard;
    beforeEach(() => {
      slugGuard = new ProjectMembershipGuard(access, new Reflector(), new KodaCaslAbilityFactory());
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
      expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'p1' }, role: 'DEVELOPER' });
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
    let guardWithCasl: ProjectMembershipGuard;

    beforeEach(() => {
      guardWithCasl = new ProjectMembershipGuard(access, new Reflector(), new KodaCaslAbilityFactory());
      membershipRepo.findBySlug.mockResolvedValue({ id: 'p1', slug: 'team', deletedAt: null });
    });

    const run = (query: Record<string, unknown>, handler = intel.searchSymbols, user: KodaPrincipal = memberUser) => {
      const req: Record<string, unknown> = { params: {}, query, user };
      return { req, result: guardWithCasl.canActivate(makeExecutionContext(req, handler, CodeIntelRoutesStub)) };
    };

    it('resolves the project from the opted-in query key and admits a DEVELOPER', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const { req, result } = run({ projectSlug: 'team' });
      await expect(result).resolves.toBe(true);
      expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'team' }, role: 'DEVELOPER' });
    });

    it('refuses a VIEWER (no READ CodeIntel)', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      await expect(run({ projectSlug: 'team' }).result).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('refuses a non-member', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue(null);
      await expect(run({ projectSlug: 'team' }).result).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it.each([
      ['missing', {}],
      ['empty', { projectSlug: '' }],
      ['repeated', { projectSlug: ['team', 'other'] }],
    ])('fails closed on a %s projectSlug without looking the project up', async (_label, query) => {
      await expect(run(query).result).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('ignores the query on routes that did not opt in', async () => {
      await expect(run({ projectSlug: 'team' }, intel.withoutSlugSource).result).rejects.toBeInstanceOf(ForbiddenAppException);
      await expect(run({ projectSlug: 'team' }, intel.plainRoute).result).resolves.toBe(true);
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('prefers params.slug over the query', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const req: Record<string, unknown> = { params: { slug: 'team' }, query: { projectSlug: 'elsewhere' }, user: memberUser };
      await expect(guardWithCasl.canActivate(makeExecutionContext(req, intel.searchSymbols, CodeIntelRoutesStub))).resolves.toBe(true);
      expect(membershipRepo.findBySlug.mock.calls[0][0]).toBe('team');
    });
  });
});
