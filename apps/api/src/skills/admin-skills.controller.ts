import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { SKILL_SOURCE_ROUTE_VARIANTS } from './skill-source-route.commands';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { CreateSkillSourceDto, SkillSourceDto, SkillSourceListDto } from './dto/skill-source.dto';
import { SkillsService } from './skills.service';

@ApiTags('skills')
@ApiBearerAuth()
@Controller('admin/skills/sources')
@UseGuards(RequiresGuard)
export class AdminSkillsController {
  constructor(private readonly skills: SkillsService, private readonly routeGate: ApprovalRouteGate) {}

  @Get()
  @Requires('skill.source.read')
  @ApiOperation({ summary: 'List registered skill sources (global admin)' })
  @ApiResponse({ status: 200, type: SkillSourceListDto })
  @ApiResponse({ status: 403, description: 'Global admin required' })
  async list() {
    return JsonResponse.Ok({ items: (await this.skills.listSources()).map(SkillSourceDto.fromDomain) });
  }

  @Post()
  @HttpCode(201)
  @Requires('skill.source.create')
  @ApprovalGated()
  @ApiOperation({ summary: 'Register and resolve a public GitHub skill source (global admin)' })
  @ApiResponse({ status: 201, type: SkillSourceDto })
  @ApiResponse({ status: 400, description: 'Invalid source URL or request' })
  @ApiResponse({ status: 403, description: 'Global admin required' })
  @ApiResponse({ status: 409, description: 'Source or skill name already registered' })
  async create(@Body() dto: CreateSkillSourceDto, @Principal() _principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<SkillSourceDto>({
      key: 'skill.source.create', variant: SKILL_SOURCE_ROUTE_VARIANTS.create,
      projectId: null, input: { source: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/update')
  @HttpCode(200)
  @Requires('skill.source.update')
  @ApprovalGated()
  @ApiOperation({ summary: 'Re-resolve a registered skill source (global admin)' })
  @ApiResponse({ status: 200, type: SkillSourceDto })
  @ApiResponse({ status: 403, description: 'Global admin required' })
  @ApiResponse({ status: 404, description: 'Skill source not found' })
  @ApiResponse({ status: 409, description: 'Skill name already registered by another source' })
  async update(@Param('id') id: string) {
    const outcome = await this.routeGate.run<SkillSourceDto>({
      key: 'skill.source.update', variant: SKILL_SOURCE_ROUTE_VARIANTS.update,
      projectId: null, input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('skill.source.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete a registered skill source (global admin)' })
  @ApiResponse({ status: 204, description: 'Skill source deleted' })
  @ApiResponse({ status: 403, description: 'Global admin required' })
  @ApiResponse({ status: 404, description: 'Skill source not found' })
  async remove(@Param('id') id: string): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'skill.source.delete',
      variant: SKILL_SOURCE_ROUTE_VARIANTS.delete,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
