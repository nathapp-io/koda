import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { RUNNER_ROUTE_VARIANTS } from './runner-route.commands';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { RunnersService } from './runners.service';
import { RunnerDto } from './dto/runner.dto';
import { UpdateRunnerDto } from './dto/update-runner.dto';
import { ListRunnersQuery } from './dto/list-runners.query';

/**
 * Fleet S1: the runner admin routes, migrated onto permission keys by permissions P1d (US-008). Each
 * key is checked with no project, so only a global grant passes — which is what
 * `@RequiredPermission('ADMIN')` meant here.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/runners')
export class RunnersController {
  constructor(
    private readonly runners: RunnersService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.runner.read')
  @ApiOperation({ summary: 'List runners (fleet.runner.read, global)' })
  @ApiResponse({ status: 200, description: 'Page of RunnerDto' })
  @ApiResponse({ status: 403, description: 'fleet.runner.read is missing globally' })
  async list(@Query() rawQuery: ListRunnersQuery) {
    const { current, size } = parseQuery(ListRunnersQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.runners.list({ current, size })));
  }

  @Get(':id')
  @UseGuards(RequiresGuard)
  @Requires('fleet.runner.read')
  @ApiOperation({ summary: 'Get a runner (fleet.runner.read, global)' })
  @ApiResponse({ status: 200, type: RunnerDto })
  @ApiResponse({ status: 403, description: 'fleet.runner.read is missing globally' })
  async get(@Param('id') id: string) {
    return JsonResponse.Ok(await this.runners.get(id));
  }

  @Patch(':id')
  @UseGuards(RequiresGuard)
  @Requires('fleet.runner.update')
  @ApprovalGated()
  @ApiOperation({ summary: 'Enable/disable a runner or change its labels or capacity (fleet.runner.update, global)' })
  @ApiResponse({ status: 200, type: RunnerDto })
  @ApiResponse({ status: 403, description: 'fleet.runner.update is missing globally' })
  async update(@Param('id') id: string, @Body() dto: UpdateRunnerDto) {
    const outcome = await this.routeGate.run<RunnerDto>({
      key: 'fleet.runner.update',
      variant: RUNNER_ROUTE_VARIANTS.update,
      projectId: null,
      input: { id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RequiresGuard)
  @Requires('fleet.runner.delete')
  @ApprovalGated()
  @ApiOperation({ summary: "Delete a runner; revokes its key (fleet.runner.delete, global)" })
  @ApiResponse({ status: 403, description: 'fleet.runner.delete is missing globally' })
  async remove(@Param('id') id: string): Promise<void> {
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.runner.delete',
      variant: RUNNER_ROUTE_VARIANTS.delete,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
