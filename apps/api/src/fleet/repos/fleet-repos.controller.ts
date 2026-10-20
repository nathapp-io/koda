import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetReposService } from './fleet-repos.service';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';

/**
 * Fleet S1: the repo admin routes, migrated onto permission keys by permissions P1d (US-008). Each key
 * is a global one, checked with no project, so only a global grant passes — which is what
 * `@RequiredPermission('ADMIN')` meant here.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/repos')
export class FleetReposController {
  constructor(private readonly repos: FleetReposService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.read')
  @ApiOperation({ summary: 'List fleet repos (fleet.repo.read, global)' })
  @ApiResponse({ status: 200, description: 'Page of FleetRepoDto' })
  @ApiResponse({ status: 403, description: 'fleet.repo.read is missing globally' })
  async list(@Query() rawQuery: ListFleetReposQuery) {
    const { current, size } = parseQuery(ListFleetReposQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.repos.list({}, { current, size })));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.create')
  @ApiOperation({ summary: 'Register a repo for fleet dispatch after proving koda can broker git access (fleet.repo.create, global)' })
  @ApiResponse({ status: 201, type: FleetRepoDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.create is missing globally' })
  @ApiResponse({ status: 409, description: 'Already registered' })
  @ApiResponse({ status: 422, description: 'Forge check failed: { reason }' })
  async create(@Body() dto: CreateFleetRepoDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.repos.create(principal.id, dto));
  }

  @Post(':id/check')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.check')
  @ApiOperation({ summary: 'Re-run the forge check for a registered repo (fleet.repo.check, global)' })
  @ApiResponse({ status: 200, type: RepoCheckResultDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.check is missing globally' })
  @ApiResponse({ status: 404, description: 'No such repo' })
  async check(@Param('id') id: string) {
    return JsonResponse.Ok(await this.repos.check(id));
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.delete')
  @ApiOperation({ summary: 'Unregister a fleet repo (fleet.repo.delete, global)' })
  @ApiResponse({ status: 403, description: 'fleet.repo.delete is missing globally' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.repos.remove(principal.id, id);
  }
}
