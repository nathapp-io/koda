/**
 * US-001 — ProjectMembershipGuard unit behaviour.
 *
 * The guard is exercised against the real ProjectAccessService over a stubbed
 * repository, so every membership decision comes from the fake ProjectMember
 * rows this file sets up rather than from a mocked access service.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ProjectAccessService } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { ProjectMembershipGuard } from './project-membership.guard';
import { ProjectRoles } from './project-roles.decorator';
import {
  AgentPrincipal,
  KodaPrincipal,
  UserPrincipal,
} from '../auth/principal/koda-principal.types';

interface MembershipRepoStub {
  findBySlug: jest.Mock;
  findMembershipRole: jest.Mock;
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
  let findMembershipRoleSpy: jest.SpyInstance;

  const activeProject = { id: 'proj-1', slug: 'alpha', deletedAt: null };

  beforeEach(() => {
    membershipRepo = { findBySlug: jest.fn(), findMembershipRole: jest.fn() };
    access = new ProjectAccessService(membershipRepo as unknown as PrismaProjectRepository);
    findMembershipRoleSpy = jest.spyOn(access, 'findMembershipRole');
    guard = new ProjectMembershipGuard(access, new Reflector());
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
  // AC2 — user principal with no ProjectMember row is refused
  // ---------------------------------------------------------------------------

  it('AC2: throws ForbiddenAppException when a user principal has no ProjectMember row for the project', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    await expect(
      guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser })),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('AC2 boundary: throws ForbiddenAppException when the membership row carries an unrecognised project role', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue('GUEST');

    await expect(
      guard.canActivate(makeExecutionContext({ params: { slug: 'alpha' }, user: memberUser })),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  // ---------------------------------------------------------------------------
  // AC3 — agents bypass the membership gate
  // ---------------------------------------------------------------------------

  it('AC3: returns true for an agent principal without a membership lookup', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);
    membershipRepo.findMembershipRole.mockResolvedValue(null);

    const result = await guard.canActivate(
      makeExecutionContext({ params: { slug: 'alpha' }, user: agentPrincipal }),
    );

    expect(result).toBe(true);
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
    const findProjectIdBySlugSpy = jest.spyOn(access, 'findProjectIdBySlug');
    const assertProjectMembershipSpy = jest.spyOn(access, 'assertProjectMembership');

    const result = await guard.canActivate(
      makeExecutionContext({ params: { id: 'ticket-1' }, user: memberUser }),
    );

    expect(result).toBe(true);
    expect(findProjectIdBySlugSpy).not.toHaveBeenCalled();
    expect(assertProjectMembershipSpy).not.toHaveBeenCalled();
    expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
  });

  it('AC6 boundary: returns true when the request has no params object at all', async () => {
    const findProjectIdBySlugSpy = jest.spyOn(access, 'findProjectIdBySlug');

    const result = await guard.canActivate(makeExecutionContext({ user: memberUser }));

    expect(result).toBe(true);
    expect(findProjectIdBySlugSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC15 / AC16 — @ProjectRoles applied to a handler
  // ---------------------------------------------------------------------------

  it('AC15: returns true for an agent principal on a handler carrying @ProjectRoles without calling findMembershipRole', async () => {
    membershipRepo.findBySlug.mockResolvedValue(activeProject);

    const result = await guard.canActivate(
      makeExecutionContext(
        { params: { slug: 'alpha' }, user: agentPrincipal },
        KbWriteRouteStub.prototype.addDocument,
        KbWriteRouteStub,
      ),
    );

    expect(result).toBe(true);
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
    expect(findMembershipRoleSpy).toHaveBeenCalledWith('proj-1', 'user-1');
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
});
