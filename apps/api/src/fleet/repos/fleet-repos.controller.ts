import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetReposService } from './fleet-repos.service';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/repos')
export class FleetReposController {
  constructor(private readonly repos: FleetReposService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List fleet repos (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of FleetRepoDto' })
  async list(@Query() rawQuery: ListFleetReposQuery) {
    const { current, size } = parseQuery(ListFleetReposQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.repos.list({}, { current, size })));
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Register a repo for fleet dispatch after proving koda can broker git access (global admin)' })
  @ApiResponse({ status: 201, type: FleetRepoDto })
  @ApiResponse({ status: 409, description: 'Already registered' })
  @ApiResponse({ status: 422, description: 'Forge check failed: { reason }' })
  async create(@Body() dto: CreateFleetRepoDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.repos.create(principal.id, dto));
  }

  @Post(':id/check')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Re-run the forge check for a registered repo (global admin)' })
  @ApiResponse({ status: 200, type: RepoCheckResultDto })
  @ApiResponse({ status: 404, description: 'No such repo' })
  async check(@Param('id') id: string) {
    return JsonResponse.Ok(await this.repos.check(id));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Unregister a fleet repo (global admin)' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.repos.remove(principal.id, id);
  }
}
