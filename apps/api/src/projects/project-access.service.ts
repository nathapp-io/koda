import { Injectable } from '@nestjs/common';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from './prisma-project.repository';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ActorRole } from '../common/enums';

@Injectable()
export class ProjectAccessService {
  constructor(private projectRepo: PrismaProjectRepository) {}

  async findProjectIdBySlug(slug: string): Promise<string> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');
    return project.id;
  }

  /**
   * Resolves the caller's role in a project with at most one query.
   * Global ADMIN -> 'ADMIN' (no query); agent -> null (no query); member ->
   * their ProjectMember.role; non-member user -> 403.
   *
   * The allow-list keeps the legacy 'AGENT' / 'MEMBER' values so older rows
   * continue to authenticate (the CASL factory collapses them to the VIEWER
   * least-privilege set — see KodaCaslAbilityFactory.projectRolePermissions).
   * New code should type the return as ProjectMemberRole.
   */
  async resolveMembership(projectId: string, principal: KodaPrincipal): Promise<string | null> {
    if (!isUserPrincipal(principal)) return null;
    if (principal.role === 'ADMIN') return ActorRole.ADMIN;
    const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
    const allowed = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT, ActorRole.VIEWER] as const;
    if (!role || !allowed.includes(role as typeof allowed[number])) {
      throw new ForbiddenAppException({}, 'projects');
    }
    return role;
  }

  async assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void> {
    await this.resolveMembership(projectId, principal);
  }

  /**
   * Thin wrapper over PrismaProjectRepository.findMembershipRole: the guard
   * resolves a project's role for a user principal to enforce an optional
   * `@ProjectRoles(...)` gate.
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
