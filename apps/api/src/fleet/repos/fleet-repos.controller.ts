import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { FLEET_REPO_ROUTE_VARIANTS } from './fleet-repo-route.commands';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { FleetReposService } from './fleet-repos.service';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';
import { UpdateAutoReviewDto } from './dto/update-auto-review.dto';

/**
 * Fleet S1: the repo admin routes, migrated onto permission keys by permissions P1d (US-008). Each key
 * is a global one, checked with no project, so only a global grant passes — which is what
 * `@RequiredPermission('ADMIN')` meant here.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/repos')
export class FleetReposController {
  constructor(
    private readonly repos: FleetReposService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

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
  @ApprovalGated()
  @ApiOperation({ summary: 'Register a repo for fleet dispatch after proving koda can broker git access (fleet.repo.create, global)' })
  @ApiResponse({ status: 201, type: FleetRepoDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.create is missing globally' })
  @ApiResponse({ status: 409, description: 'Already registered' })
  @ApiResponse({ status: 422, description: 'Forge check failed: { reason }' })
  async create(@Body() dto: CreateFleetRepoDto) {
    const outcome = await this.routeGate.run<FleetRepoDto>({
      key: 'fleet.repo.create',
      variant: FLEET_REPO_ROUTE_VARIANTS.create,
      projectId: null,
      input: dto,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/check')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.check')
  @ApprovalGated()
  @ApiOperation({ summary: 'Re-run the forge check for a registered repo (fleet.repo.check, global)' })
  @ApiResponse({ status: 200, type: RepoCheckResultDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.check is missing globally' })
  @ApiResponse({ status: 404, description: 'No such repo' })
  async check(@Param('id') id: string) {
    const outcome = await this.routeGate.run<RepoCheckResultDto>({
      key: 'fleet.repo.check',
      variant: FLEET_REPO_ROUTE_VARIANTS.check,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':id/auto-review')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.review.configure')
  @ApprovalGated()
  @ApiOperation({ summary: 'Configure auto-review for a registered repo (fleet.repo.review.configure, global)' })
  @ApiResponse({ status: 200, type: FleetRepoDto })
  @ApiResponse({ status: 403, description: 'fleet.repo.review.configure is missing globally' })
  @ApiResponse({ status: 404, description: 'No such repo' })
  @ApiResponse({ status: 422, description: 'Auto-review cannot be configured: { reason }' })
  async configureAutoReview(@Param('id') id: string, @Body() dto: UpdateAutoReviewDto) {
    const outcome = await this.routeGate.run<FleetRepoDto>({
      key: 'fleet.repo.review.configure',
      variant: FLEET_REPO_ROUTE_VARIANTS.autoReview,
      projectId: null,
      input: { id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RequiresGuard)
  @Requires('fleet.repo.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Unregister a fleet repo (fleet.repo.delete, global)' })
  @ApiResponse({ status: 403, description: 'fleet.repo.delete is missing globally' })
  async remove(@Param('id') id: string): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.repo.delete',
      variant: FLEET_REPO_ROUTE_VARIANTS.delete,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
