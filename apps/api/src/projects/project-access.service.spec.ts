import type { Mock } from 'vitest';
import { ProjectAccessService, PROJECT_ACCESS_KEY } from './project-access.service';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import type { PermissionService } from '../permissions/permission.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

/**
 * Awaits a refusal and asserts it is a ForbiddenAppException. `prefix` is the
 * i18n namespace the refusal is answered with — project access refusals answer
 * `projects`, the same namespace a non-member user gets.
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

const granted = { allowed: true, reason: 'granted' } as const;
const refused = { allowed: false, reason: 'not-granted' } as const;

interface ProjectReadAnswers {
  /** The answer for `can(principal, 'project.read', { projectId })`, the access gate. */
  inProject?: boolean;
  /** The answer for `can(principal, 'project.read')` with no context, the global ask. */
  inEveryProject?: boolean;
}

/**
 * The `project.read` answers the access gate reads. Every other key is refused, so a case that
 * reaches an unrelated check fails loudly instead of passing by accident.
 */
function projectReadAnswers({ inProject = true, inEveryProject = false }: ProjectReadAnswers = {}) {
  return async (_principal: KodaPrincipal, key: string, ctx?: { projectId: string }) => {
    if (key !== PROJECT_ACCESS_KEY) return refused;
    const allowed = ctx?.projectId === undefined ? inEveryProject : inProject;
    return allowed ? granted : refused;
  };
}

/** A `can` double that fails the case the moment it is asked anything. */
function neverAsk(): never {
  throw new Error('PermissionService.can must not be called');
}

describe('ProjectAccessService', () => {
  let service: ProjectAccessService;
  let mockProjectRepo: any;
  let can: Mock;
  let permissions: PermissionService;

  beforeEach(() => {
    mockProjectRepo = {
      findBySlug: vi.fn(),
      findMembershipRole: vi.fn(),
      isAgentOnRoster: vi.fn(),
    };
    can = vi.fn();
    permissions = { can } as unknown as PermissionService;

    service = new ProjectAccessService(mockProjectRepo as any, permissions);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findProjectIdBySlug', () => {
    it('throws NotFoundAppException when project is null', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue(null);
      await expect(service.findProjectIdBySlug('missing')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: new Date(),
      });
      await expect(service.findProjectIdBySlug('proj')).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('returns project id for an active project', async () => {
      mockProjectRepo.findBySlug.mockResolvedValue({
        id: 'p1', slug: 'proj', deletedAt: null,
      });
      expect(await service.findProjectIdBySlug('proj')).toBe('p1');
    });
  });

  /**
   * US-001: project access is holding `project.read` in the project, and the return value is the
   * caller's display role for the members page. The repository stub below is the display-role reader
   * only: it never decides admission.
   */
  describe('resolveMembership (US-001: project.read decides access)', () => {
    const memberUser: KodaPrincipal = {
      actorType: 'user', id: 'u2', role: 'MEMBER', email: 'm@m.com',
    } as KodaPrincipal;

    const adminClaimUser: KodaPrincipal = {
      actorType: 'user', id: 'u1', role: 'ADMIN', email: 'a@a.com',
    } as KodaPrincipal;

    const agentPrincipal = {
      actorType: 'agent', id: 'ag1', slug: 'agent-1', status: 'ACTIVE',
      agentRoles: [], capabilities: [],
    } as unknown as KodaPrincipal;

    const runnerPrincipal = {
      actorType: 'runner', id: 'run1', runnerName: 'runner-1', labels: [],
      enabled: true, capacity: 1,
    } as unknown as KodaPrincipal;

    it('AC-1: returns the display role when project.read is held in the project only', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: true, inEveryProject: false }));
      mockProjectRepo.findMembershipRole.mockResolvedValue('DEVELOPER');

      await expect(service.resolveMembership('p1', memberUser)).resolves.toBe('DEVELOPER');

      expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY, { projectId: 'p1' });
      expect(mockProjectRepo.findMembershipRole).toHaveBeenCalledWith('p1', 'u2');
    });

    it('AC-2: returns ADMIN when project.read is held globally as well', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: true, inEveryProject: true }));

      await expect(service.resolveMembership('p1', memberUser)).resolves.toBe('ADMIN');

      expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY);
      // A principal that reads every project needs no per-project display role.
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('AC-3: refuses a user whose role claim is ADMIN but who does not hold project.read here', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: false, inEveryProject: false }));

      const error = await expectForbidden(service.resolveMembership('p1', adminClaimUser), 'projects');

      expect(error.code).toBe(40003);
      expect(error.httpStatus).toBe(403);
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('AC-4: resolves null for an agent whose project.read is granted, whatever the roster says', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: true }));
      mockProjectRepo.isAgentOnRoster.mockResolvedValue(false);

      await expect(service.resolveMembership('p1', agentPrincipal)).resolves.toBeNull();

      expect(can).toHaveBeenCalledWith(agentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'p1' });
      expect(mockProjectRepo.isAgentOnRoster).not.toHaveBeenCalled();
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('AC-5: refuses an agent whose project.read is refused, whatever the roster says', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: false }));
      mockProjectRepo.isAgentOnRoster.mockResolvedValue(true);

      const error = await expectForbidden(service.resolveMembership('p1', agentPrincipal), 'projects');

      expect(error.code).toBe(40003);
      expect(can).toHaveBeenCalledWith(agentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'p1' });
      expect(mockProjectRepo.isAgentOnRoster).not.toHaveBeenCalled();
    });

    it('AC-6: admits an agent without asking when agent project scoping is off', async () => {
      const unscoped = new ProjectAccessService(
        mockProjectRepo as any,
        permissions,
        { agentProjectScoping: false } as any,
      );
      can.mockImplementation(neverAsk);

      await expect(unscoped.resolveMembership('p1', agentPrincipal)).resolves.toBeNull();

      expect(can).not.toHaveBeenCalled();
      expect(mockProjectRepo.isAgentOnRoster).not.toHaveBeenCalled();
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('AC-7: admits a runner without asking', async () => {
      can.mockImplementation(neverAsk);

      await expect(service.resolveMembership('p1', runnerPrincipal)).resolves.toBeNull();

      expect(can).not.toHaveBeenCalled();
      expect(mockProjectRepo.isAgentOnRoster).not.toHaveBeenCalled();
    });

    it('AC-8: propagates a database error from can unchanged', async () => {
      const databaseError = new Error('db down');
      can.mockRejectedValue(databaseError);

      await expect(service.resolveMembership('p1', memberUser)).rejects.toBe(databaseError);
    });
  });

  describe('assertProjectMembership (US-001: delegates to resolveMembership)', () => {
    const memberUser: KodaPrincipal = {
      actorType: 'user', id: 'u2', role: 'MEMBER', email: 'm@m.com',
    } as KodaPrincipal;

    const agentPrincipal = {
      actorType: 'agent', id: 'ag1', slug: 'agent-1', status: 'ACTIVE',
      agentRoles: [], capabilities: [],
    } as unknown as KodaPrincipal;

    it('resolves for a user holding project.read in the project', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: true }));
      mockProjectRepo.findMembershipRole.mockResolvedValue('DEVELOPER');

      await expect(service.assertProjectMembership('p1', memberUser)).resolves.toBeUndefined();
      expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY, { projectId: 'p1' });
    });

    it('resolves for an agent holding project.read in the project', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: true }));

      await expect(service.assertProjectMembership('p1', agentPrincipal)).resolves.toBeUndefined();
      expect(can).toHaveBeenCalledWith(agentPrincipal, PROJECT_ACCESS_KEY, { projectId: 'p1' });
    });

    it('refuses a user without project.read with a projects-scoped 403', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: false }));

      await expectForbidden(service.assertProjectMembership('p1', memberUser), 'projects');
    });
  });

  describe('readsEveryProject (US-001)', () => {
    const memberUser: KodaPrincipal = {
      actorType: 'user', id: 'u2', role: 'MEMBER', email: 'm@m.com',
    } as KodaPrincipal;

    const adminClaimUser: KodaPrincipal = {
      actorType: 'user', id: 'u1', role: 'ADMIN', email: 'a@a.com',
    } as KodaPrincipal;

    const runnerPrincipal = {
      actorType: 'runner', id: 'run1', runnerName: 'runner-1', labels: [],
      enabled: true, capacity: 1,
    } as unknown as KodaPrincipal;

    it('AC-9: is true when project.read is held globally', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: false, inEveryProject: true }));

      await expect(service.readsEveryProject(memberUser)).resolves.toBe(true);

      expect(can).toHaveBeenCalledWith(memberUser, PROJECT_ACCESS_KEY);
    });

    it('AC-9: is false when project.read is refused globally', async () => {
      can.mockImplementation(projectReadAnswers({ inProject: true, inEveryProject: false }));

      await expect(service.readsEveryProject(adminClaimUser)).resolves.toBe(false);

      expect(can).toHaveBeenCalledWith(adminClaimUser, PROJECT_ACCESS_KEY);
    });

    it('AC-10: is false for a runner without asking', async () => {
      can.mockImplementation(neverAsk);

      await expect(service.readsEveryProject(runnerPrincipal)).resolves.toBe(false);

      expect(can).not.toHaveBeenCalled();
    });
  });
});
