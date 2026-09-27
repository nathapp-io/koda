import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ProjectAccessService } from './project-access.service';
import { PROJECT_ROLES_KEY } from './project-roles.decorator';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';

/**
 * Guards project-scoped routes by `params.slug`.
 *
 * Flow:
 *  1. If the route has no `slug` param, return true — sibling guards handle it.
 *  2. Resolve the project via ProjectAccessService.findProjectIdBySlug (404 if
 *     missing or soft-deleted).
 *  3. Call ProjectAccessService.assertProjectMembership (403 for a non-member
 *     user). Agents and global ADMIN users are admitted without a membership
 *     lookup.
 *  4. If the handler (or class) carries `@ProjectRoles(...)`, additionally
 *     refuse a user principal whose ProjectMember.role is not in the list.
 *     Agents and global ADMIN users skip this check.
 */
@Injectable()
export class ProjectMembershipGuard implements CanActivate {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ params?: { slug?: string }; user?: KodaPrincipal }>();
    const slug = req.params?.slug;
    if (!slug) return true;

    if (!req.user) throw new ForbiddenAppException({}, 'projects');

    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectMembership(projectId, req.user);

    const roles = this.reflector.getAllAndOverride<string[]>(PROJECT_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles?.length && isUserPrincipal(req.user) && req.user.role !== 'ADMIN') {
      const role = await this.access.findMembershipRole(projectId, req.user.id);
      if (!role || !roles.includes(role)) {
        throw new ForbiddenAppException({}, 'projects');
      }
    }

    return true;
  }
}
