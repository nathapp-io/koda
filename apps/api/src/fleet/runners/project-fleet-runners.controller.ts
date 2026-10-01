import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { RunnersService } from './runners.service';
import { ListRunnersQuery } from './dto/list-runners.query';
import { RunnerSummaryDto } from './dto/runner-summary.dto';

// Nothing else references RunnerSummaryDto (the page response has only a description), so without
// ApiExtraModels it is missing from openapi.json and the CLI has no type for it (verified 2026-10-01).
@ApiExtraModels(RunnerSummaryDto)
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/runners')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetRunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Get()
  @ApiOperation({ summary: 'Runner summaries for dispatch and job lists (project member)' })
  @ApiResponse({ status: 200, description: 'Page of RunnerSummaryDto, ordered by name' })
  async list(@Query() rawQuery: ListRunnersQuery) {
    const { current, size } = parseQuery(ListRunnersQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.runners.listSummaries({ current, size })));
  }
}
