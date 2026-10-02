import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ProjectFleetSchedulesController } from './project-fleet-schedules.controller';
import { ScheduleProgressService } from './schedule-progress.service';
import { ScheduleTicker } from './schedule-ticker';
import { SchedulesModule } from './schedules.module';
import { SchedulesService } from './schedules.service';

/** DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('SchedulesModule', () => {
  it('compiles and resolves the ticker, the service, the progress service and the controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, SchedulesModule] }).compile();
    try {
      expect(moduleRef.get(ScheduleTicker)).toBeDefined();
      expect(moduleRef.get(SchedulesService)).toBeDefined();
      expect(moduleRef.get(ScheduleProgressService, { strict: false })).toBeDefined();
      expect(moduleRef.get(ProjectFleetSchedulesController)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
