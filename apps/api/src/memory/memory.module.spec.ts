import { Test, TestingModule } from '@nestjs/testing';
import { MemoryModule } from './memory.module';
import { MemoryReadController } from './memory-read.controller';
import { MemoryGovernanceService } from './memory-governance.service';
import { ProjectsService } from '../projects/projects.service';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

describe('MemoryModule (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('compiles with the global stub providers and no database', async () => {
    await expect(
      Test.createTestingModule({
        imports: [GlobalStubsModule, MemoryModule],
      }).compile(),
    ).resolves.toBeDefined();
  });

  describe('AC10: new memory-read controller and its dependencies resolve from DI', () => {
    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, MemoryModule],
      }).compile();
    });

    it('registers MemoryReadController', () => {
      expect(moduleRef.get(MemoryReadController)).toBeInstanceOf(MemoryReadController);
    });

    it('registers MemoryGovernanceService', () => {
      expect(moduleRef.get(MemoryGovernanceService)).toBeInstanceOf(MemoryGovernanceService);
    });

    it('resolves ProjectsService (imported via ProjectsModule)', () => {
      expect(moduleRef.get(ProjectsService)).toBeInstanceOf(ProjectsService);
    });
  });
});
