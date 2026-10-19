import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectScopedRequest } from '../projects/project-context';
import { findCatalogEntry } from './catalog';
import { PermissionService } from './permission.service';
import { REQUIRES_METADATA, type RequiresMetadata } from './requires.decorator';

/**
 * Permissions P1: the one route-level check.
 *
 * A migrated route declares its catalog keys with `@Requires` and lists this guard *after*
 * `ProjectMembershipGuard`, in the same `@UseGuards(...)` call, so `request.projectContext` is
 * already resolved (design §"`@Requires` and `RequiresGuard`"). No provider entry is needed: the
 * guard depends only on `Reflector` and the global `PermissionService`.
 *
 * Every branch that cannot prove the caller holds the key refuses with the `permissions` code:
 * an unknown key, a role key without a principal, and a project key on a request where no project
 * was resolved. The one deliberate pass-through short of a grant is `not-owner`: holding `X.own`
 * grants the route, and the handler decides on the row it loaded.
 */
@Injectable()
export class RequiresGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequiresMetadata | undefined>(REQUIRES_METADATA, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta || meta.enforcedBy === 'service') return true;

    const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
    const projectId = req.projectContext?.project.id;
    const results = await Promise.all(meta.keys.map((key) => this.passes(req.user, key, projectId)));
    const ok = meta.mode === 'all' ? results.every(Boolean) : results.some(Boolean);
    if (!ok) throw new ForbiddenAppException({}, 'permissions');
    return true;
  }

  private async passes(
    principal: KodaPrincipal | undefined,
    key: string,
    projectId: string | undefined,
  ): Promise<boolean> {
    const entry = findCatalogEntry(key);
    if (!entry) return false; // unknown key: fail closed
    if (entry.access === 'public') return true; // no principal needed
    if (!principal) return false;
    if (entry.scope === 'project' && !projectId) return false; // project key outside a resolved project: fail closed
    const decision = await this.permissions.can(principal, key, projectId ? { projectId } : {});
    // Holding only `key.own` passes the route; the service checks the row.
    return decision.allowed || decision.reason === 'not-owner';
  }
}
