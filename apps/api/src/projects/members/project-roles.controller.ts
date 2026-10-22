import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { RoleAdminService } from '../../permissions/role-admin.service';
import { ProjectMembershipGuard } from '../project-membership.guard';
import { ProjectRoleDto } from './dto/project-role.dto';

/**
 * Permissions P1 web US-003: the roles a member of this project can be given.
 *
 * `role.read` is a global key and a Project Admin does not hold it, so a project's own roles used to be
 * unlistable by the person binding them. This route answers the PROJECT-scope roles behind the project
 * gate instead: any member holding `member.read` may read the vocabulary it can hand out.
 *
 * The guards run in order: `ProjectMembershipGuard` resolves `request.projectContext` and refuses a
 * principal with no access to the project (403 `projects`), then `RequiresGuard` reads the route's key.
 * The service checks nothing itself — it lists every PROJECT role, and the guard decides who may ask.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/roles')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectRolesController {
  constructor(private readonly roles: RoleAdminService) {}

  @Get()
  @Requires('member.read')
  @ApiOperation({ summary: 'List the project roles a member can be given (member.read)' })
  @ApiResponse({
    status: 200,
    type: [ProjectRoleDto],
    description: 'Every PROJECT-scope role, system roles first then by key',
  })
  @ApiResponse({ status: 403, description: 'Not a project member, or member.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list() {
    const roles = await this.roles.listProjectRoles();
    return JsonResponse.Ok(roles.map((role) => ProjectRoleDto.from(role)));
  }
}
