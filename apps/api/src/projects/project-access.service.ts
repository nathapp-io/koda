import { Injectable } from '@nestjs/common';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from './prisma-project.repository';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ActorRole } from '../common/enums';
import { PermissionService } from '../permissions/permission.service';

/** The key whose holding in a project is access to it (design §2 "Project access"; ruling 2026-10-21). */
export const PROJECT_ACCESS_KEY = 'project.read';

@Injectable()
export class ProjectAccessService {
  constructor(
    private projectRepo: PrismaProjectRepository,
    private readonly permissions: PermissionService,
  ) {}

  async findProjectIdBySlug(slug: string, notFoundPrefix: 'projects' | 'rag' = 'projects'): Promise<string> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, notFoundPrefix);
    return project.id;
  }

  /**
   * The access gate, and the caller's display role for the reads that still render one (the workspace
   * thread stream). Permissions P1l US-006 removed the members page's `viewerRole`, so no members response
   * carries it. A runner is not checked (unchanged; `CombinedAuthGuard` keeps runners off project routes),
   * and every agent is checked for `project.read`.
   *
   * Access is holding `project.read` in the project, whatever the caller's `role` claim or legacy membership row
   * says: a custom project role narrows and widens it. The returned role is display only (`findMembershipRole`),
   * and a principal that holds `project.read` globally is an ADMIN here — as granted by a global
   * Owner/Admin binding through `PermissionService`. A database error from `can` propagates
   * unchanged; no refusal is invented.
   */
  async resolveMembership(projectId: string, principal: KodaPrincipal): Promise<string | null> {
    if (principal.actorType === 'runner') return null;
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
   * display-only read (the workspace thread stream). It decides no access — that is `resolveMembership`'s
   * 403 on `project.read`.
   */
  async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
    return this.projectRepo.findMembershipRole(projectId, userId);
  }
}
