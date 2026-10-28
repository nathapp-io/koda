import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { SCHEDULE_ROUTE_VARIANTS } from './schedule-route.commands';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleDto } from './dto/schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { SchedulesService } from './schedules.service';

/**
 * S1b §3.4 project routes (plan D202), migrated onto permission keys by permissions P1d (US-005): a
 * member reads with `fleet.schedule.read`; `fleet.schedule.create` creates; `fleet.schedule.update` and
 * `.delete` are ownable, so a Developer holds the `.own` forms and the service keeps "owner or project
 * ADMIN" under the row lock. `canAdminister` is the any-row key (a project ADMIN, and a global ADMIN
 * through its `*`), never `ProjectContext.role`.
 *
 * Every route declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`, so the membership
 * guard resolves `request.projectContext` before the key check and runs exactly once per request.
 * `RequiresGuard` passes a caller holding only `X.own` (`not-owner`) on purpose: the row is not loaded
 * yet, and the handler's service decides on it.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/schedules')
export class ProjectFleetSchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly permissions: PermissionService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.read')
  @ApiOperation({ summary: 'List the project\'s schedules (fleet.schedule.read)' })
  @ApiResponse({ status: 200, type: [ScheduleDto] })
  @ApiResponse({ status: 403, description: 'fleet.schedule.read is missing' })
  async list(@CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.schedules.list(ctx.project.id));
  }

  @Get(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.read')
  @ApiOperation({ summary: 'Get a schedule (fleet.schedule.read)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 403, description: 'fleet.schedule.read is missing' })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.schedules.get(ctx.project.id, id));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.create')
  @ApiOperation({ summary: 'Create a schedule that runs one feature on a cron (fleet.schedule.create)' })
  @ApiResponse({ status: 201, type: ScheduleDto })
  @ApiResponse({ status: 400, description: 'Invalid template, cron or timezone, or fleet.scheduleCronTooFrequent (fires closer than 15 minutes)' })
  @ApiResponse({ status: 403, description: 'fleet.schedule.create is missing' })
  @ApiResponse({ status: 404, description: 'Repo not in this project, or pinned runner unknown' })
  @ApiResponse({ status: 422, description: 'Pinned runner can never run this job' })
  async create(@Body() dto: CreateScheduleDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.schedules.create(principal.id, ctx.project.id, dto));
  }

  @Patch(':id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.update')
  @ApiOperation({ summary: 'Change a schedule (fleet.schedule.update: the owner, or the any-row key)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds fleet.schedule.update nor created the schedule' })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  async update(@Param('id') id: string, @Body() dto: UpdateScheduleDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const canAdminister = await this.canAdminister(principal, 'fleet.schedule.update', ctx);
    return JsonResponse.Ok(await this.schedules.update(principal.id, ctx.project.id, id, dto, canAdminister));
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete a schedule; its jobs are kept (fleet.schedule.delete: the owner, or the any-row key)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'The caller neither holds fleet.schedule.delete nor created the schedule' })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.schedule.delete', variant: SCHEDULE_ROUTE_VARIANTS.delete,
      projectId: ctx.project.id, input: { projectId: ctx.project.id, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }

  @Post(':id/enable')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.update')
  @ApiOperation({ summary: 'Enable a schedule: resets the stall counter and recomputes the next fire (fleet.schedule.update)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds fleet.schedule.update nor created the schedule' })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  @ApiResponse({ status: 409, description: 'fleet.scheduleOwnerNoAccess: the owner no longer holds fleet.job.dispatch in this project' })
  async enable(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const canAdminister = await this.canAdminister(principal, 'fleet.schedule.update', ctx);
    return JsonResponse.Ok(await this.schedules.enable(principal.id, ctx.project.id, id, canAdminister));
  }

  @Post(':id/disable')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.schedule.update')
  @ApiOperation({ summary: 'Disable a schedule (fleet.schedule.update: the owner, or the any-row key)' })
  @ApiResponse({ status: 200, type: ScheduleDto })
  @ApiResponse({ status: 403, description: 'The caller neither holds fleet.schedule.update nor created the schedule' })
  @ApiResponse({ status: 404, description: 'Schedule not found in this project' })
  async disable(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    const canAdminister = await this.canAdminister(principal, 'fleet.schedule.update', ctx);
    return JsonResponse.Ok(await this.schedules.disable(principal.id, ctx.project.id, id, canAdminister));
  }

  /**
   * The any-row half of "owner or project ADMIN": a caller holding the plain key administers every row;
   * one holding only `X.own` is answered `not-owner` here (no resource is passed), so the service keeps
   * the `createdById === actorId` rule.
   */
  private async canAdminister(principal: KodaPrincipal, key: string, ctx: ProjectContext): Promise<boolean> {
    return (await this.permissions.can(principal, key, { projectId: ctx.project.id })).allowed;
  }
}
