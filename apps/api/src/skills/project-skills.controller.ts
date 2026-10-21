import { Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { CurrentProject } from '../projects/current-project.decorator';
import type { ProjectContext } from '../projects/project-context';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { ProjectSkillDto, ProjectSkillListDto } from './dto/project-skill.dto';
import { SkillsService } from './skills.service';

@ApiTags('skills')
@ApiBearerAuth()
@Controller('projects/:slug/skills')
@ApiParam({ name: 'slug', description: 'Project slug' })
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @Requires('skill.project.read')
  @ApiOperation({ summary: 'List catalog skills and their project enablement' })
  @ApiResponse({ status: 200, type: ProjectSkillListDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Project membership required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@CurrentProject() ctx: ProjectContext) {
    const items = await this.skills.listProjectSkills(ctx.project.id);
    return JsonResponse.Ok({ items: items.map(ProjectSkillDto.fromDomain) });
  }

  @Put(':skillId')
  @Requires('skill.project.enable')
  @ApiOperation({ summary: 'Enable a catalog skill for this project' })
  @ApiResponse({ status: 200, type: ProjectSkillDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Project admin required' })
  @ApiResponse({ status: 404, description: 'Project or skill not found' })
  async enable(
    @Param('skillId') skillId: string,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ) {
    const skill = await this.skills.enableProjectSkill(ctx.project.id, skillId, principal.id);
    return JsonResponse.Ok(ProjectSkillDto.fromDomain(skill));
  }

  @Delete(':skillId')
  @HttpCode(204)
  @Requires('skill.project.disable')
  @ApiOperation({ summary: 'Disable a catalog skill for this project' })
  @ApiResponse({ status: 204, description: 'Skill disabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Project admin required' })
  @ApiResponse({ status: 404, description: 'Project or skill not found' })
  async disable(
    @Param('skillId') skillId: string,
    @CurrentProject() ctx: ProjectContext,
  ): Promise<void> {
    await this.skills.disableProjectSkill(ctx.project.id, skillId);
  }
}
