import { Body, Controller, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FakeFleetRepoFilesReader } from './fake-fleet-repo-files.reader';

/**
 * Test-only (S3 plan C11, same rules as D213): seeds the fake repo files the E2E config page reads. 404 unless
 * FLEET_TEST_HOOKS and FLEET_TEST_FAKE_NAX_FILES are true outside production; global ADMIN; not in openapi.json.
 */
// No @ApiTags/@ApiOperation (.nax/rules/api-controllers.md): excluded from OpenAPI on purpose, like FleetTestHooksController.
@ApiExcludeController()
@Controller('fleet/test-hooks/repos')
export class FleetConfigTestHooksController {
  constructor(
    private readonly fake: FakeFleetRepoFilesReader,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'testHooksEnabled' | 'testFakeNaxFiles'>,
  ) {}

  @Put(':repoId/nax-files')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  seed(@Param('repoId') repoId: string, @Body() body: { files?: Record<string, string> }) {
    if (!this.fleetConfig.testHooksEnabled || !this.fleetConfig.testFakeNaxFiles) throw new NotFoundAppException({}, 'fleet.repos');
    const files = Object.fromEntries(Object.entries(body?.files ?? {}).filter(([, v]) => typeof v === 'string'));
    return JsonResponse.Ok(this.fake.seed(repoId, files));
  }
}
