import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { CreateSkillSourceDto, SkillSourceDto, SkillSourceListDto } from './dto/skill-source.dto';
import { SkillsService } from './skills.service';

@ApiTags('skills')
@ApiBearerAuth()
@Controller('admin/skills/sources')
export class AdminSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List registered skill sources (global admin)' })
  @ApiResponse({ status: 200, type: SkillSourceListDto })
  @ApiResponse({ status: 403, description: 'Global admin required' })
  async list() {
    return JsonResponse.Ok({ items: (await this.skills.listSources()).map(SkillSourceDto.fromDomain) });
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Register and resolve a public GitHub skill source (global admin)' })
  @ApiResponse({ status: 201, type: SkillSourceDto })
  @ApiResponse({ status: 400, description: 'Invalid source URL or request' })
  @ApiResponse({ status: 403, description: 'Global admin required' })
  @ApiResponse({ status: 409, description: 'Source or skill name already registered' })
  async create(@Body() dto: CreateSkillSourceDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(SkillSourceDto.fromDomain(await this.skills.createSource(dto, principal)));
  }
}
