import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { FleetModule } from '../fleet.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { IngestModule } from '../ingest/ingest.module';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { BundleIngestService } from '../ingest/bundle-ingest.service';
import { FleetRulingsModule } from './fleet-rulings.module';
import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import { FLEET_PR_RULING_REPOSITORY } from './fleet-pr-ruling.domain';

describe('FleetRulingsModule', () => {
  let module: TestingModule;
  afterEach(async () => { await module?.close(); });
  it('resolves Jobs and Ingest with Rulings without a cycle or DB', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetJobsModule, IngestModule] }).compile();
    expect(module.get(FleetJobsService)).toBeInstanceOf(FleetJobsService);
    expect(module.get(BundleIngestService)).toBeInstanceOf(BundleIngestService);
    expect(module.get(FleetPrRulingsService)).toBeInstanceOf(FleetPrRulingsService);
  });
  it('compiles without DB, keeps repositories private and joins FleetModule', async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, FleetRulingsModule] }).compile();
    expect(module.get(FleetPrRulingsService)).toBeInstanceOf(FleetPrRulingsService);
    expect(module.get(FLEET_PR_RULING_REPOSITORY)).toBeDefined();
    expect(Reflect.getMetadata('exports', FleetRulingsModule)).toEqual([FleetPrRulingsService]);
    expect(Reflect.getMetadata('imports', FleetModule)).toContain(FleetRulingsModule);
    expect((Reflect.getMetadata('imports', FleetRulingsModule) as { name: string }[]).map((module) => module.name)).not.toContain('FleetJobsModule');
    const { FleetRulingRouteCommands, FLEET_RULING_ROUTE_VARIANTS } = await import('./fleet-ruling-route.commands');
    const { ApprovalCommandRegistry } = await import('../../approvals/approval-command.registry');
    module.get(FleetRulingRouteCommands).onModuleInit();
    expect(module.get(ApprovalCommandRegistry).get('fleet.job.rule', FLEET_RULING_ROUTE_VARIANTS.create)).toBeDefined();
  });
});
