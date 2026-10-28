import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { REPO_CONFIG_ROUTE_VARIANTS } from './repo-config-route.commands';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { DispatchResultDto } from '../jobs/dto/fleet-job.dto';
import { ConfigJobsService } from './config-jobs.service';
import { NaxFileContentDto, NaxFileListDto, RegenerateConfigDto, SubmitConfigEditDto } from './dto/config-edit.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/repos/:repoId')
// Permissions P1d (US-007): each route declares `ProjectMembershipGuard, RequiresGuard` in one
// `@UseGuards`, so the membership guard resolves `request.projectContext` before the key check.
export class ProjectRepoConfigController {
  constructor(
    private readonly configJobs: ConfigJobsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get('nax-files')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.repo.config.read')
  @ApiOperation({ summary: "The repo's allowlisted .nax files at the default-branch head (fleet.repo.config.read)" })
  @ApiResponse({ status: 200, type: NaxFileListDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.config.read is missing' })
  @ApiResponse({ status: 409, description: 'koda cannot read the repo (fleet.repoUnreachable)' })
  @ApiResponse({ status: 502, description: 'The forge failed' })
  async list(@Param('repoId') repoId: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.configJobs.listFiles(ctx.project.id, repoId));
  }

  @Get('nax-files/content')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.repo.config.read')
  @ApiOperation({ summary: 'One allowlisted .nax file at a commit (fleet.repo.config.read)' })
  @ApiQuery({ name: 'path', required: true })
  @ApiQuery({ name: 'ref', required: false, description: 'Commit id from nax-files baseSha; defaults to the default branch' })
  @ApiResponse({ status: 200, type: NaxFileContentDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.config.read is missing' })
  @ApiResponse({ status: 422, description: 'Over 256 KiB or not UTF-8 text (fleet.naxFile)' })
  async read(
    @Param('repoId') repoId: string, @Query('path') path: string, @Query('ref') ref: string | undefined,
    @CurrentProject() ctx: ProjectContext,
  ) {
    return JsonResponse.Ok(await this.configJobs.readFile(ctx.project.id, repoId, path, ref || undefined));
  }

  @Post('config-edits')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.config.edit')
  @ApiOperation({ summary: 'Queue a CONFIG_EDIT job: a runner applies the edits, regenerates, validates and opens a PR (fleet.job.config.edit)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'fleet.job.config.edit is missing' })
  @ApiResponse({ status: 409, description: 'A config job is already active for this repo (fleet.configJobActive)' })
  async submitEdit(@Param('repoId') repoId: string, @Body() body: SubmitConfigEditDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitEdit(principal.id, ctx.project.id, repoId, body));
  }

  @Post('config-edits/regenerate')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.config.edit')
  @ApiOperation({ summary: 'Queue a regenerate PR (CONFIG_EDIT with no file edits) (fleet.job.config.edit)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'fleet.job.config.edit is missing' })
  async submitRegenerate(@Param('repoId') repoId: string, @Body() body: RegenerateConfigDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitRegenerate(principal.id, ctx.project.id, repoId, body));
  }

  @Post('drift-checks')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.repo.drift.check')
  @ApprovalGated()
  @ApiOperation({ summary: 'Queue a read-only CONFIG_DRIFT job (fleet.repo.drift.check)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.drift.check is missing' })
  async submitDrift(@Param('repoId') repoId: string, @CurrentProject() ctx: ProjectContext) {
    const outcome = await this.routeGate.run<DispatchResultDto>({
      key: 'fleet.repo.drift.check', variant: REPO_CONFIG_ROUTE_VARIANTS.driftCheck,
      projectId: ctx.project.id, input: { projectId: ctx.project.id, repoId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
