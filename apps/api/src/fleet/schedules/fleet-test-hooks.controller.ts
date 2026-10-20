import { Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { IScheduleRepository, SCHEDULE_REPOSITORY } from './domain/schedule.domain';
import { ScheduleTicker } from './schedule-ticker';

/**
 * Test-only (S1b 3b D213): fires one schedule by running a ticker round at its `nextFireAt`, so the web E2E needs
 * neither the 60 s timer nor a per-minute cron (the 15-minute gap check refuses one). The claim, coalesce and dispatch
 * path is the real one. 404 unless FLEET_TEST_HOOKS=true outside production; `testhook.schedule.fire` (global); not in
 * openapi.json. Permissions P1d (US-008) replaced its `@RequiredPermission('ADMIN')` with that catalog key, so the
 * 404-when-off and the key refusal keep their order.
 */
// No @ApiTags/@ApiOperation (.nax/rules/api-controllers.md): the controller is excluded from OpenAPI on purpose (D213).
@ApiExcludeController()
@Controller('fleet/test-hooks')
export class FleetTestHooksController {
  constructor(
    private readonly ticker: ScheduleTicker,
    @Inject(SCHEDULE_REPOSITORY) private readonly schedules: IScheduleRepository,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'testHooksEnabled'>,
  ) {}

  @Post('schedules/:id/fire')
  @HttpCode(200)
  @UseGuards(RequiresGuard)
  @Requires('testhook.schedule.fire')
  async fire(@Param('id') id: string) {
    // Off looks the same as an unknown schedule: nothing about the hook is disclosed.
    if (!this.fleetConfig.testHooksEnabled) throw new NotFoundAppException({}, 'fleet.schedules');
    const schedule = await this.schedules.findById(id);
    if (!schedule) throw new NotFoundAppException({}, 'fleet.schedules');
    if (!schedule.enabled) throw new ConflictAppException({}, 'fleet.scheduleDisabled');
    const at = schedule.nextFireAt;
    return JsonResponse.Ok({ firedAt: at.toISOString(), result: await this.ticker.tick(at) });
  }
}
