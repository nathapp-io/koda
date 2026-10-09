import { CanActivate, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ProjectAccessService } from './project-access.service';
import { PROJECT_ROLES_KEY } from './project-roles.decorator';
import { PROJECT_PERMISSION_KEY, ProjectPermissionMetadata } from './project-permission.decorator';
import { PROJECT_SLUG_FROM_KEY, ProjectSlugSource } from './project-slug-from.decorator';
import { ProjectScopedRequest, withProjectRole } from './project-context';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';

/**
 * Guards project-scoped routes by `params.slug`.
 *
 * Flow:
 *  1. No slug (`params.slug`, or the @ProjectSlugFrom query key): return true
 *     (sibling guards handle it), unless the route carries @ProjectPermission,
 *     which fails closed.
 *  2. Resolve the project (404 if missing or soft-deleted) and the caller's
 *     membership role ONCE (403 for a non-member user; global ADMIN -> 'ADMIN',
 *     no query; agent -> roster-checked, returns null, one query).
 *  3. Attach `request.projectContext` for @CurrentProject() (#145, guard half).
 *  4. @ProjectRoles(...): refuse a non-admin user whose role is not listed.
 *  5. @ProjectPermission(...): check it against the ability for
 *     `{ ...principal, projectRole }` (#144). Agents are evaluated with their
 *     agent-role ability unless the route exempts them.
 */
@Injectable()
export class ProjectMembershipGuard implements CanActivate {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly reflector: Reflector,
    @Optional() private readonly caslAbilityFactory?: KodaCaslAbilityFactory,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
    const permission = this.reflector.getAllAndOverride<ProjectPermissionMetadata | undefined>(
      PROJECT_PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const slug = this.resolveSlug(ctx, req);
    if (!slug) {
      if (permission) throw new ForbiddenAppException({}, 'projects');
      return true;
    }

    if (!req.user) throw new ForbiddenAppException({}, 'projects');

    const projectId = await this.access.findProjectIdBySlug(slug);
    const role = await this.access.resolveMembership(projectId, req.user);
    req.projectContext = { project: { id: projectId, slug }, role };

    this.assertProjectRoles(ctx, req.user, role);
    if (permission) await this.assertProjectPermission(permission, req.user, role);
    return true;
  }

  /**
   * `params.slug`, else the query key a route opted into with @ProjectSlugFrom.
   * A missing, empty or repeated (array) query value is no slug, so a
   * @ProjectPermission route fails closed instead of guessing.
   */
  private resolveSlug(ctx: ExecutionContext, req: ProjectScopedRequest): string | undefined {
    if (req.params?.slug) return req.params.slug;
    const from = this.reflector.getAllAndOverride<ProjectSlugSource | undefined>(PROJECT_SLUG_FROM_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!from) return undefined;
    const value = req.query?.[from.key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private assertProjectRoles(ctx: ExecutionContext, user: KodaPrincipal, role: string | null): void {
    const roles = this.reflector.getAllAndOverride<string[]>(PROJECT_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles?.length || !isUserPrincipal(user) || user.role === 'ADMIN') return;
    if (!role || !roles.includes(role)) throw new ForbiddenAppException({}, 'projects');
  }

  private async assertProjectPermission(
    meta: ProjectPermissionMetadata,
    user: KodaPrincipal,
    role: string | null,
  ): Promise<void> {
    if (meta.exemptAgents && isAgentPrincipal(user)) return;
    if (!this.caslAbilityFactory) throw new ForbiddenAppException({}, 'projects');
    const ability = await this.caslAbilityFactory.createForUser(withProjectRole(user, role));
    const [action, subject] = meta.permission;
    if (!ability.can(action, subject)) throw new ForbiddenAppException({}, 'projects');
  }
}
