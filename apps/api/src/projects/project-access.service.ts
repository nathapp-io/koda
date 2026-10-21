import { Injectable, Inject, Optional } from '@nestjs/common';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from './prisma-project.repository';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ActorRole } from '../common/enums';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { PermissionService } from '../permissions/permission.service';

/** The key whose holding in a project is access to it (design §2 "Project access"; ruling 2026-10-21). */
export const PROJECT_ACCESS_KEY = 'project.read';

@Injectable()
export class ProjectAccessService {
  constructor(
    private projectRepo: PrismaProjectRepository,
    private readonly permissions: PermissionService,
    @Optional() @Inject(AUTH_CFG) private authConfig?: IAuthConfig,
  ) {}

  /**
   * S4c US-001 (D528): an absent config means scoping is on. Only an explicit
   * `agentProjectScoping: false` restores the pre-S4c agent reach.
   */
  agentScopingEnabled(): boolean {
    return this.authConfig?.agentProjectScoping !== false;
  }

  async findProjectIdBySlug(slug: string): Promise<string> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');
    return project.id;
  }

  /**
   * The access gate, and the caller's display role for the members page (`viewerRole`, read by the web until
   * permissions-p1-web). A runner is not checked (unchanged; `CombinedAuthGuard` keeps runners off project routes),
   * and an agent passes while AGENT_PROJECT_SCOPING is off (unchanged until drop-legacy).
   *
   * Access is holding `project.read` in the project, whatever the caller's `role` claim or legacy membership row
   * says: a custom project role narrows and widens it. The returned role is display only (`findMembershipRole`),
   * and a principal that holds `project.read` globally is an ADMIN here — which is what `User.role = 'ADMIN'` and a
   * global Owner/Admin binding both resolve to through `PermissionService`. A database error from `can` propagates
   * unchanged; no refusal is invented.
   */
  async resolveMembership(projectId: string, principal: KodaPrincipal): Promise<string | null> {
    if (principal.actorType === 'runner') return null;
    if (isAgentPrincipal(principal) && !this.agentScopingEnabled()) return null;
    const decision = await this.permissions.can(principal, PROJECT_ACCESS_KEY, { projectId });
    if (!decision.allowed) throw new ForbiddenAppException({}, 'projects');
    if (!isUserPrincipal(principal)) return null;
    if (await this.readsEveryProject(principal)) return ActorRole.ADMIN;
    return this.projectRepo.findMembershipRole(projectId, principal.id);
  }

  async assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void> {
    await this.resolveMembership(projectId, principal);
  }

  /** Whether the principal holds `project.read` globally (with the seeded roles: a global Owner or Admin). */
  async readsEveryProject(principal: KodaPrincipal): Promise<boolean> {
    if (principal.actorType === 'runner') return false;
    return (await this.permissions.can(principal, PROJECT_ACCESS_KEY)).allowed;
  }

  /**
   * Thin wrapper over PrismaProjectRepository.findMembershipRole: a project's raw membership role for a
   * display-only read (the workspace thread stream, `viewerRole`). It decides no access — that is
   * `resolveMembership`'s 403 on `project.read`.
   */
  async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
    return this.projectRepo.findMembershipRole(projectId, userId);
  }

  /**
   * Membership management: global ADMIN, or a user whose project role is ADMIN.
   * Agents never manage membership. Reads the role live (membership is not cached).
   */
  async assertProjectAdmin(projectId: string, principal: KodaPrincipal): Promise<void> {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'members');
    if (principal.role === 'ADMIN') return;
    const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
    if (role !== ActorRole.ADMIN) throw new ForbiddenAppException({}, 'members');
  }

  /**
   * Non-throwing twin of assertProjectAdmin: whether this principal may manage
   * project membership. Used to tell the UI whether to render the controls.
   */
  async canManageMembers(projectId: string, principal: KodaPrincipal): Promise<boolean> {
    if (!isUserPrincipal(principal)) return false;
    if (principal.role === 'ADMIN') return true;
    return (await this.projectRepo.findMembershipRole(projectId, principal.id)) === ActorRole.ADMIN;
  }
}
