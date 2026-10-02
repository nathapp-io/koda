import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleDto } from './dto/schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { SchedulesService } from './schedules.service';

/** Project ADMIN, which a global ADMIN resolves to (`ProjectContext.role`). The other half of "owner or project ADMIN". */
const canAdminister = (ctx: ProjectContext): boolean => ctx.role === 'ADMIN';

function requireUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/**
 * S1b §3.4 project routes (plan D202): any project member reads; create needs DEVELOPER+; edit, enable, disable and
 * delete need DEVELOPER+ and the schedule's owner or a project ADMIN.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/schedules')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetSchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @ApiOperation({ summary: 'List the project\'s schedules (project member)' })
  @ApiResponse({ status: 200, type: [ScheduleDto] })
  async list(@CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    return JsonResponse.Ok(await this.schedules.list(ctx.project.id));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a schedule (project member)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    return JsonResponse.Ok(await this.schedules.get(ctx.project.id, id));
  }

  @Post()
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Create a schedule that runs one feature on a cron (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: ScheduleDto })
  @ApiResponse({ status: 400, description: 'Invalid template, cron or timezone, or fleet.scheduleCronTooFrequent (fires closer than 15 minutes)' })
  @ApiResponse({ status: 404, description: 'Repo not in this project, or pinned runner unknown' })
  @ApiResponse({ status: 422, description: 'Pinned runner can never run this job' })
  async create(@Body() dto: CreateScheduleDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.create(principal.id, ctx.project.id, dto));
  }

  @Patch(':id')
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Change a schedule (owner or project ADMIN)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 403, description: 'Not the owner and not a project ADMIN' })
  async update(@Param('id') id: string, @Body() dto: UpdateScheduleDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.update(principal.id, ctx.project.id, id, dto, canAdminister(ctx)));
  }

  @Delete(':id')
  @HttpCode(204)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Delete a schedule; its jobs are kept (owner or project ADMIN)' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.schedules.remove(principal.id, ctx.project.id, id, canAdminister(ctx));
  }

  @Post(':id/enable')
  @HttpCode(200)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Enable a schedule: resets the stall counter and recomputes the next fire (owner or project ADMIN)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 409, description: 'fleet.scheduleOwnerNoAccess: the owner is disabled or no longer has DEVELOPER access to the project' })
  async enable(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.enable(principal.id, ctx.project.id, id, canAdminister(ctx)));
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Disable a schedule (owner or project ADMIN)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  async disable(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.disable(principal.id, ctx.project.id, id, canAdminister(ctx)));
  }
}
