import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { isAgentPrincipal, isUserPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { MePermissionsDto, MePermissionsQuery } from './dto/me-permissions.dto';
import { ProjectAccessService } from './project-access.service';

/**
 * The principal as the permission layer spells it, built exactly as `PermissionService.can` builds it.
 * A runner principal reaches no route here (`CombinedAuthGuard` keeps runner keys on the
 * `@RunnerRoute()` routes), so the third branch fails closed rather than guessing a type.
 */
function principalRef(principal: KodaPrincipal): PrincipalRef {
  if (isUserPrincipal(principal)) return { type: 'USER', id: principal.id };
  if (isAgentPrincipal(principal)) return { type: 'AGENT', id: principal.id };
  throw new ForbiddenAppException({}, 'permissions');
}

/**
 * Permissions P1 US-001: the caller's own effective keys, so a client can gate fail-closed.
 *
 * The keys are the role-derived ones only (`effectiveKeys`, sorted ascending): an implicit key such as
 * `auth.me.read` or a public key such as `session.login` is never listed, because the API always
 * allows it and a client that gated on its absence would hide actions the server accepts.
 *
 * The route lives in `ProjectsModule` because it needs `ProjectAccessService`; `PermissionsModule` is
 * global, so nothing else has to be imported. `auth.me.read` is implicit — every authenticated
 * principal holds it — so the guard passes any caller and the project access is decided by
 * `ProjectAccessService.resolveMembership` (`project.read`, 403 `projects`), after the slug lookup
 * (404 `projects`).
 */
@ApiTags('permissions')
@ApiBearerAuth()
@Controller('me/permissions')
export class MePermissionsController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('auth.me.read')
  @ApiOperation({ summary: 'The permission keys I hold, globally or in one project' })
  @ApiResponse({ status: 200, type: MePermissionsDto })
  @ApiResponse({ status: 400, description: 'An empty project slug' })
  @ApiResponse({ status: 403, description: 'No project.read in the project' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async read(@Query() query: MePermissionsQuery, @Principal() principal: KodaPrincipal) {
    const ref = principalRef(principal);
    const slug = query.project;

    if (!slug) {
      const keys = await this.permissions.effectiveKeys(ref, 'global');
      return JsonResponse.Ok(MePermissionsDto.of('global', null, keys));
    }

    // The slug lookup answers 404 `projects`; the membership gate then answers 403 `projects` when the
    // caller does not hold `project.read` there.
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.resolveMembership(projectId, principal);
    const keys = await this.permissions.effectiveKeys(ref, { projectId });
    return JsonResponse.Ok(MePermissionsDto.of('project', slug, keys));
  }
}
