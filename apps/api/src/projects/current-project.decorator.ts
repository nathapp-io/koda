import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { ProjectContext, ProjectScopedRequest } from './project-context';

/**
 * The ProjectContext ProjectMembershipGuard attached. Throws (fail closed) if a
 * handler reads it on a route the guard did not resolve.
 */
export const CurrentProject = createParamDecorator((_data: unknown, ctx: ExecutionContext): ProjectContext => {
  const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
  if (!req.projectContext) throw new ForbiddenAppException({}, 'projects');
  return req.projectContext;
});
