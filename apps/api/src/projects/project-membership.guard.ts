import { PROJECT_NOT_FOUND_PREFIX } from './project-not-found-prefix.decorator';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ProjectAccessService } from './project-access.service';
import { PROJECT_SLUG_FROM_KEY, ProjectSlugSource } from './project-slug-from.decorator';
import { ProjectScopedRequest } from './project-context';

/**
 * Guards project-scoped routes by `params.slug`.
 *
 * Flow:
 *  1. No slug (`params.slug`, or the @ProjectSlugFrom query or body key): return true and let the
 *     sibling guard decide.
 *  2. Resolve the project (404 if missing or soft-deleted) and the caller's access to it once (403 when
 *     `project.read` is refused).
 *  3. Attach `request.projectContext` — the project's identity only — for @CurrentProject().
 *
 * Permissions P1 (US-004): the guard decides access and nothing else. It reads no role and no
 * permission metadata, and the request it annotates carries no role.
 */
@Injectable()
export class ProjectMembershipGuard implements CanActivate {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
    const slug = this.resolveSlug(ctx, req);
    if (!slug) return true;
    if (!req.user) throw new ForbiddenAppException({}, 'projects');

    const prefix = this.reflector.getAllAndOverride<'projects' | 'rag' | undefined>(PROJECT_NOT_FOUND_PREFIX, [ctx.getHandler(), ctx.getClass()]);
    const projectId = prefix
      ? await this.access.findProjectIdBySlug(slug, prefix)
      : await this.access.findProjectIdBySlug(slug);
    await this.access.resolveMembership(projectId, req.user);
    req.projectContext = { project: { id: projectId, slug } };
    return true;
  }

  /** `params.slug`, else the query or body key selected by @ProjectSlugFrom; anything else is no slug. */
  private resolveSlug(ctx: ExecutionContext, req: ProjectScopedRequest): string | undefined {
    if (req.params?.slug) return req.params.slug;
    const from = this.reflector.getAllAndOverride<ProjectSlugSource | undefined>(PROJECT_SLUG_FROM_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!from) return undefined;
    const source = from.source === 'query'
      ? req.query
      : typeof req.body === 'object' && req.body !== null
        ? req.body as Record<string, unknown>
        : undefined;
    const value = source?.[from.key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
