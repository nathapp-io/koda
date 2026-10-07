import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { DispatchResultDto } from '../jobs/dto/fleet-job.dto';
import { ConfigJobsService } from './config-jobs.service';
import { NaxFileContentDto, NaxFileListDto, RegenerateConfigDto, SubmitConfigEditDto } from './dto/config-edit.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/repos/:repoId')
@UseGuards(ProjectMembershipGuard)
export class ProjectRepoConfigController {
  constructor(private readonly configJobs: ConfigJobsService) {}

  @Get('nax-files')
  @ApiOperation({ summary: "The repo's allowlisted .nax files at the default-branch head (project member)" })
  @ApiResponse({ status: 200, type: NaxFileListDto })
  @ApiResponse({ status: 409, description: 'koda cannot read the repo (fleet.repoUnreachable)' })
  @ApiResponse({ status: 502, description: 'The forge failed' })
  async list(@Param('repoId') repoId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.configJobs.listFiles(ctx.project.id, repoId));
  }

  @Get('nax-files/content')
  @ApiOperation({ summary: 'One allowlisted .nax file at a commit (project member)' })
  @ApiQuery({ name: 'path', required: true })
  @ApiQuery({ name: 'ref', required: false, description: 'Commit id from nax-files baseSha; defaults to the default branch' })
  @ApiResponse({ status: 200, type: NaxFileContentDto })
  @ApiResponse({ status: 422, description: 'Over 256 KiB or not UTF-8 text (fleet.naxFile)' })
  async read(
    @Param('repoId') repoId: string, @Query('path') path: string, @Query('ref') ref: string | undefined,
    @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal,
  ) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.configJobs.readFile(ctx.project.id, repoId, path, ref || undefined));
  }

  @Post('config-edits')
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Queue a CONFIG_EDIT job: a runner applies the edits, regenerates, validates and opens a PR (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 409, description: 'A config job is already active for this repo (fleet.configJobActive)' })
  async submitEdit(@Param('repoId') repoId: string, @Body() body: SubmitConfigEditDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitEdit(principal.id, ctx.project.id, repoId, body));
  }

  @Post('config-edits/regenerate')
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Queue a regenerate PR (CONFIG_EDIT with no file edits) (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  async submitRegenerate(@Param('repoId') repoId: string, @Body() body: RegenerateConfigDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitRegenerate(principal.id, ctx.project.id, repoId, body));
  }

  @Post('drift-checks')
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Queue a read-only CONFIG_DRIFT job (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  async submitDrift(@Param('repoId') repoId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.configJobs.submitDrift(principal.id, ctx.project.id, repoId));
  }
}
