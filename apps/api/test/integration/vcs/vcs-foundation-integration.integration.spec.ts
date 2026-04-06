/**
 * VCS Foundation Integration Test
 *
 * End-to-end integration test simulating real usage:
 * - VcsService depends on ConfigService for vcsConfig
 * - VcsService uses encryption utility to encrypt/decrypt tokens
 * - VcsService persists data using Prisma models
 *
 * This test verifies all acceptance criteria work together.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/vcs-foundation-integration.integration.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { vcsConfig } from '../../../src/config/vcs.config';
import { encryptToken, decryptToken } from '../../../src/common/utils/encryption.util';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Mock VCS service that uses config and encryption
 */
@Injectable()
class MockVcsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  getEncryptionKey(): string | undefined {
    return this.configService.get('vcs.encryptionKey');
  }

  getDefaultPollingInterval(): number {
    return this.configService.get('vcs.defaultPollingIntervalMs');
  }

  getGithubApiUrl(): string {
    return this.configService.get('vcs.githubApiUrl');
  }

  encryptApiKey(plaintext: string): string {
    const key = this.getEncryptionKey();
    if (!key) {
      throw new Error('Encryption key not configured');
    }
    return encryptToken(plaintext, key);
  }

  decryptApiKey(encrypted: string): string {
    const key = this.getEncryptionKey();
    if (!key) {
      throw new Error('Encryption key not configured');
    }
    return decryptToken(encrypted, key);
  }

  async createVcsConnection(
    projectId: string,
    provider: string,
    repoOwner: string,
    repoName: string,
    apiKey: string,
  ) {
    const encryptedToken = this.encryptApiKey(apiKey);

    return this.prisma.client.vcsConnection.create({
      data: {
        projectId,
        provider,
        repoOwner,
        repoName,
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: this.getDefaultPollingInterval(),
        webhookSecret: crypto.randomBytes(16).toString('hex'),
        isActive: true,
      },
    });
  }

  async getVcsConnectionWithDecryptedToken(vcsConnectionId: string) {
    const vc = await this.prisma.client.vcsConnection.findUnique({
      where: { id: vcsConnectionId },
    });

    if (!vc) return null;

    return {
      ...vc,
      decryptedToken: this.decryptApiKey(vc.encryptedToken),
    };
  }

  async logSync(vcsConnectionId: string, issuesSynced: number, issuesSkipped: number) {
    return this.prisma.client.vcsSyncLog.create({
      data: {
        vcsConnectionId,
        syncType: 'issues',
        issuesSynced,
        issuesSkipped,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('VCS Foundation Integration (All AC)', () => {
  let module: TestingModule;
  let vcsService: MockVcsService;
  let prisma: PrismaService<PrismaClient>;
  let tmpDbPath: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    tmpDbPath = path.join(os.tmpdir(), `koda-vcs-integration-${Date.now()}.db`);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [vcsConfig],
        }),
      ],
      providers: [MockVcsService],
    }).compile();

    vcsService = module.get(MockVcsService);

    // Create test database
    const testPrisma = new PrismaClient({
      datasources: {
        db: {
          url: `file:${tmpDbPath}`,
        },
      },
    });

    try {
      const { execSync } = await import('child_process');
      execSync('bunx prisma db push --force-reset --skip-generate', {
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: `file:${tmpDbPath}` },
      });
    } catch (error) {
      // Migration may fail if DB is already initialized, which is OK
    }

    // Inject Prisma into service
    Object.defineProperty(vcsService, 'prisma', {
      value: { client: testPrisma },
      writable: true,
    });

    prisma = { client: testPrisma } as any;
  });

  afterAll(async () => {
    if (module) {
      await module.close();
    }
    if (prisma?.client) {
      await prisma.client.$disconnect();
    }
    if (tmpDbPath && fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  });

  describe('AC9: vcsConfig registration and access', () => {
    it('vcsConfig is registered and accessible via ConfigService', () => {
      const configService = module.get(ConfigService);
      const vcs = configService.get('vcs');

      expect(vcs).toBeDefined();
      expect(vcs.encryptionKey).toBeDefined();
      expect(vcs.defaultPollingIntervalMs).toBeDefined();
      expect(vcs.githubApiUrl).toBeDefined();
    });

    it('service can read vcsConfig properties', () => {
      const interval = vcsService.getDefaultPollingInterval();
      const githubUrl = vcsService.getGithubApiUrl();

      expect(typeof interval).toBe('number');
      expect(interval).toBeGreaterThan(0);
      expect(typeof githubUrl).toBe('string');
      expect(githubUrl).toMatch(/^https?:\/\//);
    });
  });

  describe('AC5 + AC9: encryptToken with vcsConfig encryption key', () => {
    it('AC5: encryptToken returns format "iv:authTag:ciphertext"', () => {
      process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

      try {
        const plaintext = 'ghp_test_token_12345';
        const encrypted = vcsService.encryptApiKey(plaintext);

        const segments = encrypted.split(':');
        expect(segments.length).toBe(3);
        expect(/^[0-9a-f]{32}$/.test(segments[0])).toBe(true);
        expect(/^[0-9a-f]{32}$/.test(segments[1])).toBe(true);
        expect(/^[0-9a-f]+$/.test(segments[2])).toBe(true);
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });

    it('throws error when encryption key is not configured', () => {
      delete process.env['VCS_ENCRYPTION_KEY'];

      expect(() => {
        vcsService.encryptApiKey('some_token');
      }).toThrow('Encryption key not configured');
    });
  });

  describe('AC6 + AC9: decryptToken with vcsConfig encryption key', () => {
    it('AC6: decryptToken returns original plaintext with correct key', () => {
      const testKey = crypto.randomBytes(32).toString('hex');
      process.env['VCS_ENCRYPTION_KEY'] = testKey;

      try {
        const plaintext = 'ghp_original_token_xyz';
        const encrypted = vcsService.encryptApiKey(plaintext);
        const decrypted = vcsService.decryptApiKey(encrypted);

        expect(decrypted).toBe(plaintext);
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });

    it('AC8: decryptToken throws with wrong master key', () => {
      process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

      try {
        const plaintext = 'token_to_encrypt';
        const encrypted = vcsService.encryptApiKey(plaintext);

        // Change the key
        process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

        expect(() => {
          vcsService.decryptApiKey(encrypted);
        }).toThrow();
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });
  });

  describe('AC1 + AC9: Create VcsConnection with encrypted token', () => {
    it('creates VcsConnection with encrypted API key from vcsConfig', async () => {
      process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

      try {
        // Create project
        const project = await prisma.client.project.create({
          data: {
            name: 'VCS Integration Test',
            slug: 'vcs-integration-test',
            key: 'VCSI',
          },
        });

        const plainApiKey = 'ghp_test_integration_key_12345';

        // Create VcsConnection via service (uses encryption)
        const vc = await vcsService.createVcsConnection(
          project.id,
          'github',
          'test-owner',
          'test-repo',
          plainApiKey,
        );

        expect(vc).toBeDefined();
        expect(vc.encryptedToken).not.toBe(plainApiKey);
        expect(vc.encryptedToken).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);
        expect(vc.pollingIntervalMs).toBe(vcsService.getDefaultPollingInterval());
        expect(vc.isActive).toBe(true);

        // Verify we can decrypt it
        const decrypted = vcsService.decryptApiKey(vc.encryptedToken);
        expect(decrypted).toBe(plainApiKey);

        // Cleanup
        await prisma.client.vcsConnection.delete({ where: { id: vc.id } });
        await prisma.client.project.delete({ where: { id: project.id } });
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });
  });

  describe('AC2 + AC9: Create and log VcsSyncLog', () => {
    it('creates VcsSyncLog with proper fields', async () => {
      process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

      try {
        // Setup
        const project = await prisma.client.project.create({
          data: { name: 'SyncLogIntegration', slug: 'sync-log-int', key: 'SLGI' },
        });

        const vc = await vcsService.createVcsConnection(
          project.id,
          'github',
          'owner',
          'repo',
          'test_token',
        );

        // Create sync log
        const log = await vcsService.logSync(vc.id, 42, 3);

        expect(log.vcsConnectionId).toBe(vc.id);
        expect(log.syncType).toBe('issues');
        expect(log.issuesSynced).toBe(42);
        expect(log.issuesSkipped).toBe(3);
        expect(log.startedAt).toBeInstanceOf(Date);
        expect(log.completedAt).toBeInstanceOf(Date);

        // Cleanup
        await prisma.client.vcsSyncLog.delete({ where: { id: log.id } });
        await prisma.client.vcsConnection.delete({ where: { id: vc.id } });
        await prisma.client.project.delete({ where: { id: project.id } });
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });
  });

  describe('AC3 + AC4: Project and Ticket extensions', () => {
    it('ticket can have VCS fields and relates to project with vcsConnection', async () => {
      process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

      try {
        // Create project with VcsConnection
        const project = await prisma.client.project.create({
          data: { name: 'ExtensionTest', slug: 'ext-test', key: 'EXTE' },
        });

        const vc = await vcsService.createVcsConnection(
          project.id,
          'github',
          'owner',
          'repo',
          'token',
        );

        // Create ticket with VCS fields
        const ticket = await prisma.client.ticket.create({
          data: {
            projectId: project.id,
            number: 1,
            type: 'BUG',
            title: 'Test ticket with VCS sync',
            externalVcsId: 'github-12345',
            externalVcsUrl: 'https://github.com/owner/repo/issues/42',
            vcsSyncedAt: new Date(),
          },
        });

        // Verify project has vcsConnection
        const projectWithVcs = await prisma.client.project.findUnique({
          where: { id: project.id },
          include: { vcsConnection: true },
        });

        expect(projectWithVcs.vcsConnection).toBeDefined();
        expect(projectWithVcs.vcsConnection.id).toBe(vc.id);

        // Verify ticket has VCS fields
        expect(ticket.externalVcsId).toBe('github-12345');
        expect(ticket.externalVcsUrl).toBe('https://github.com/owner/repo/issues/42');
        expect(ticket.vcsSyncedAt).toBeInstanceOf(Date);

        // Cleanup
        await prisma.client.ticket.delete({ where: { id: ticket.id } });
        await prisma.client.vcsConnection.delete({ where: { id: vc.id } });
        await prisma.client.project.delete({ where: { id: project.id } });
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });
  });

  describe('AC7: Tampered ciphertext detection', () => {
    it('AC7: decryptToken throws on tampered ciphertext', () => {
      process.env['VCS_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

      try {
        const plaintext = 'sensitive_token';
        const encrypted = vcsService.encryptApiKey(plaintext);
        const [iv, authTag, ciphertext] = encrypted.split(':');

        // Tamper with ciphertext
        const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -4)}abcd`;

        expect(() => {
          vcsService.decryptApiKey(tampered);
        }).toThrow();
      } finally {
        delete process.env['VCS_ENCRYPTION_KEY'];
      }
    });
  });
});
