import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { FleetModule } from '../fleet.module';
import { FleetRulingsModule } from './fleet-rulings.module';
import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import { FLEET_PR_RULING_REPOSITORY } from './fleet-pr-ruling.domain';

describe('FleetRulingsModule', () => {
  let module: TestingModule;
  afterEach(async () => { await module?.close(); });
  it('compiles without DB, keeps repositories private and joins FleetModule', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetRulingsModule] }).compile();
    expect(module.get(FleetPrRulingsService)).toBeInstanceOf(FleetPrRulingsService);
    expect(module.get(FLEET_PR_RULING_REPOSITORY)).toBeDefined();
    expect(Reflect.getMetadata('exports', FleetRulingsModule)).toEqual([FleetPrRulingsService]);
    expect(Reflect.getMetadata('imports', FleetModule)).toContain(FleetRulingsModule);
    expect(Reflect.getMetadata('imports', FleetRulingsModule) ?? []).toEqual([]);
  });
});
