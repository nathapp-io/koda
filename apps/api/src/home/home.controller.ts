import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../auth/principal/koda-principal.types';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { PermissionService } from '../permissions/permission.service';
import { HomeService } from './home.service';
import { HomeActivityDto, HomeDashboardDto } from './dto/home-dashboard.dto';

/**
 * The home dashboard is for people; agent keys get 403, like the fleet read controllers.
 *
 * Permissions P1 (US-010): `home.read` is an implicit key, so any authenticated principal passes
 * `RequiresGuard` and the users-only rule stays in the handler.
 *
 * Permissions P1 (US-002): the dashboard's `globalAdmin` scope is the `project.read` key held
 * globally, not the principal's `role` claim.
 */
@ApiTags('home')
@ApiBearerAuth()
@ApiExtraModels(HomeActivityDto)
@Controller('home')
export class HomeController {
  constructor(
    private readonly home: HomeService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('home.read')
  @ApiOperation({ summary: "The signed-in user's cross-project dashboard: assigned tickets, pending approvals, attention jobs, projects, recent activity" })
  @ApiResponse({ status: 200, type: HomeDashboardDto })
  @ApiResponse({ status: 403, description: 'Agents have no home dashboard' })
  async get(@Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    const globalAdmin = (await this.permissions.can(principal, 'project.read')).allowed;
    return JsonResponse.Ok(await this.home.snapshot({ id: principal.id, globalAdmin }, new Date()));
  }
}
