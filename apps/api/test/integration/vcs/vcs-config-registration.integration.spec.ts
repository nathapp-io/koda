/**
 * VCS Config Registration Integration Tests
 *
 * Verifies that vcsConfig is properly registered in the application ConfigModule
 * and can be injected into services.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/vcs-config-registration.integration.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { vcsConfig } from '../../../src/config/vcs.config';
import * as crypto from 'crypto';

describe('VCS Config Registration (Integration)', () => {
  let configService: ConfigService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [vcsConfig],
        }),
      ],
    }).compile();

    configService = module.get(ConfigService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('vcsConfig registration', () => {
    it('should register vcsConfig with namespace "vcs"', () => {
      const vcsNamespace = configService.get('vcs');
      expect(vcsNamespace).toBeDefined();
      expect(typeof vcsNamespace).toBe('object');
    });

    it('should be injectable via ConfigService.get()', () => {
      const vcsConfig = configService.get('vcs');
      expect(vcsConfig).toBeDefined();
    });

    it('should provide encryptionKey property', () => {
      const vcsConfig = configService.get('vcs');
      expect('encryptionKey' in vcsConfig).toBe(true);
    });

    it('should provide defaultPollingIntervalMs property', () => {
      const vcsConfig = configService.get('vcs');
      expect('defaultPollingIntervalMs' in vcsConfig).toBe(true);
    });

    it('should provide githubApiUrl property', () => {
      const vcsConfig = configService.get('vcs');
      expect('githubApiUrl' in vcsConfig).toBe(true);
    });
  });

  describe('vcsConfig.encryptionKey injection', () => {
    it('should read VCS_ENCRYPTION_KEY from environment', async () => {
      const testKey = crypto.randomBytes(32).toString('hex');
      process.env['VCS_ENCRYPTION_KEY'] = testKey;

      try {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              isGlobal: true,
              load: [vcsConfig],
            }),
          ],
        }).compile();

        const cs = module.get(ConfigService);
        const vcs = cs.get('vcs');
        expect(vcs.encryptionKey).toBe(testKey);

        await module.close();
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });

    it('should be undefined if VCS_ENCRYPTION_KEY is not set', () => {
      delete process.env['VCS_ENCRYPTION_KEY'];
      const vcsConfig = configService.get('vcs');
      expect(vcsConfig.encryptionKey).toBeUndefined();
    });
  });

  describe('vcsConfig.defaultPollingIntervalMs injection', () => {
    it('should parse VCS_DEFAULT_POLLING_INTERVAL_MS as number', async () => {
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] = '300000';

      try {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              isGlobal: true,
              load: [vcsConfig],
            }),
          ],
        }).compile();

        const cs = module.get(ConfigService);
        const vcs = cs.get('vcs');
        expect(typeof vcs.defaultPollingIntervalMs).toBe('number');
        expect(vcs.defaultPollingIntervalMs).toBe(300000);

        await module.close();
      } finally {
        delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
      }
    });

    it('should use default value (3600000ms/1 hour) when env var not set', () => {
      delete process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'];
      const vcsConfig = configService.get('vcs');

      expect(typeof vcsConfig.defaultPollingIntervalMs).toBe('number');
      expect(vcsConfig.defaultPollingIntervalMs).toBe(3600000);
    });
  });

  describe('vcsConfig.githubApiUrl injection', () => {
    it('should read VCS_GITHUB_API_URL from environment', async () => {
      const testUrl = 'https://github.enterprise.com/api/v3';
      process.env['VCS_GITHUB_API_URL'] = testUrl;

      try {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              isGlobal: true,
              load: [vcsConfig],
            }),
          ],
        }).compile();

        const cs = module.get(ConfigService);
        const vcs = cs.get('vcs');
        expect(vcs.githubApiUrl).toBe(testUrl);

        await module.close();
      } finally {
        delete process.env['VCS_GITHUB_API_URL'];
      }
    });

    it('should default to https://api.github.com when env var not set', () => {
      delete process.env['VCS_GITHUB_API_URL'];
      const vcsConfig = configService.get('vcs');

      expect(vcsConfig.githubApiUrl).toBe('https://api.github.com');
    });
  });

  describe('vcsConfig consistency across service access patterns', () => {
    it('should return consistent config when called multiple times', () => {
      const vcs1 = configService.get('vcs');
      const vcs2 = configService.get('vcs');

      expect(vcs1.defaultPollingIntervalMs).toBe(vcs2.defaultPollingIntervalMs);
      expect(vcs1.githubApiUrl).toBe(vcs2.githubApiUrl);
    });

    it('should support typed config access', () => {
      const vcsConfig = configService.get<{
        encryptionKey?: string;
        defaultPollingIntervalMs: number;
        githubApiUrl: string;
      }>('vcs');

      expect(vcsConfig).toBeDefined();
      expect(typeof vcsConfig.defaultPollingIntervalMs).toBe('number');
      expect(typeof vcsConfig.githubApiUrl).toBe('string');
    });
  });
});
