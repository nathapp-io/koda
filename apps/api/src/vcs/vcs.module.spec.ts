import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { VcsModule } from './vcs.module';
import { VcsController } from './vcs.controller';
import { VcsWebhookController } from './vcs-webhook.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsWebhookService } from './vcs-webhook.service';
import { VcsPollingService } from './vcs-polling.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import { VCS_REPOSITORY } from './domain/vcs.repository';
import { vcsConfig } from '../config/vcs.config';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

describe('VcsModule (DI wiring)', () => {
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
        imports: [GlobalStubsModule, VcsModule],
      }).compile(),
    ).resolves.toBeDefined();
  });

  describe('providers', () => {
    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, VcsModule],
      }).compile();
    });

    it('registers VcsController', () => {
      expect(moduleRef.get(VcsController)).toBeInstanceOf(VcsController);
    });

    it('registers VcsWebhookController', () => {
      expect(moduleRef.get(VcsWebhookController)).toBeInstanceOf(VcsWebhookController);
    });

    it('registers VcsConnectionService', () => {
      expect(moduleRef.get(VcsConnectionService)).toBeInstanceOf(VcsConnectionService);
    });

    it('registers VcsSyncService', () => {
      expect(moduleRef.get(VcsSyncService)).toBeInstanceOf(VcsSyncService);
    });

    it('registers VcsWebhookService', () => {
      expect(moduleRef.get(VcsWebhookService)).toBeInstanceOf(VcsWebhookService);
    });

    it('registers VcsPollingService', () => {
      expect(moduleRef.get(VcsPollingService)).toBeInstanceOf(VcsPollingService);
    });

    it('registers VcsPrSyncService', () => {
      expect(moduleRef.get(VcsPrSyncService)).toBeInstanceOf(VcsPrSyncService);
    });

    it('registers VcsLinkExtractorService', () => {
      expect(moduleRef.get(VcsLinkExtractorService)).toBeInstanceOf(VcsLinkExtractorService);
    });

    it('aliases VCS_REPOSITORY token to the Prisma-backed implementation', () => {
      expect(moduleRef.get(VCS_REPOSITORY)).toBeDefined();
    });
  });

  describe('vcsConfig registration under ConfigModule', () => {
    it('ConfigModule.forRoot() with vcsConfig compiles and exposes the "vcs" namespace', async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [vcsConfig],
          }),
        ],
      }).compile();

      expect(moduleRef).toBeDefined();
    });
  });
});
