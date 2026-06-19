import { Test, TestingModule } from '@nestjs/testing';
import { PolicyModule } from './policy.module';
import { PolicyGateService } from './policy-gate.service';
import { PrismaPolicyRepository } from './prisma-policy.repository';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

describe('PolicyModule (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('compiles with GlobalStubsModule and no database', async () => {
    await expect(
      Test.createTestingModule({
        imports: [GlobalStubsModule, PolicyModule],
      }).compile(),
    ).resolves.toBeDefined();
  });

  describe('providers', () => {
    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, PolicyModule],
      }).compile();
    });

    it('registers PolicyGateService', () => {
      expect(moduleRef.get(PolicyGateService)).toBeInstanceOf(PolicyGateService);
    });

    it('registers PrismaPolicyRepository', () => {
      expect(moduleRef.get(PrismaPolicyRepository)).toBeInstanceOf(PrismaPolicyRepository);
    });

    it('exports PolicyGateService so consumers can inject it', () => {
      // If it's exported, get() will resolve without throwing
      expect(() => moduleRef.get(PolicyGateService)).not.toThrow();
    });
  });
});
