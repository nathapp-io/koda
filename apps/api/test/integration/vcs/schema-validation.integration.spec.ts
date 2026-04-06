/**
 * VCS Schema Validation Tests
 *
 * Validates that the Prisma schema exactly matches all acceptance criteria
 * for VcsConnection, VcsSyncLog, and extended Ticket/Project models.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/schema-validation.integration.spec.ts
 */

import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('VCS Schema Validation', () => {
  let prisma: PrismaClient;
  let tmpDbPath: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    tmpDbPath = path.join(os.tmpdir(), `koda-schema-test-${Date.now()}.db`);

    prisma = new PrismaClient({
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
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
    if (tmpDbPath && fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  });

  describe('VcsConnection model schema validation', () => {
    it('AC1: model exists with all required fields', async () => {
      expect(prisma.vcsConnection).toBeDefined();

      // Create test project
      const project = await prisma.project.create({
        data: { name: 'Test', slug: 'test', key: 'TEST' },
      });

      // AC1: VcsConnection with all required fields
      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      // Validate all fields exist
      expect(vc.id).toBeDefined();
      expect(vc.projectId).toBe(project.id);
      expect(vc.provider).toBe('github');
      expect(vc.repoOwner).toBe('owner');
      expect(vc.repoName).toBe('repo');
      expect(vc.encryptedToken).toBe('token');
      expect(vc.syncMode).toBe('polling');
      expect(vc.allowedAuthors).toBe('[]');
      expect(vc.pollingIntervalMs).toBe(300000);
      expect(vc.webhookSecret).toBe('secret');
      expect(vc.lastSyncedAt).toBeNull();
      expect(vc.isActive).toBe(true);
      expect(vc.createdAt).toBeInstanceOf(Date);
      expect(vc.updatedAt).toBeInstanceOf(Date);

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vc.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: projectId is unique (one-to-one relationship)', async () => {
      const project = await prisma.project.create({
        data: { name: 'UniqueTest', slug: 'unique-test', key: 'UNIQ' },
      });

      await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      // Attempting second VcsConnection for same project should fail
      await expect(
        prisma.vcsConnection.create({
          data: {
            projectId: project.id,
            provider: 'gitlab',
            repoOwner: 'owner2',
            repoName: 'repo2',
            encryptedToken: 'token2',
            syncMode: 'polling',
            allowedAuthors: '[]',
            pollingIntervalMs: 300000,
            webhookSecret: 'secret2',
            isActive: true,
          },
        }),
      ).rejects.toThrow();

      // Cleanup
      const vcs = await prisma.vcsConnection.findUnique({
        where: { projectId: project.id },
      });
      if (vcs) {
        await prisma.vcsConnection.delete({ where: { id: vcs.id } });
      }
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: projectId cascade delete works correctly', async () => {
      const project = await prisma.project.create({
        data: { name: 'CascadeTest', slug: 'cascade-test', key: 'CASC' },
      });

      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const vcId = vc.id;

      // Delete project
      await prisma.project.delete({ where: { id: project.id } });

      // VcsConnection should be cascade deleted
      const deleted = await prisma.vcsConnection.findUnique({
        where: { id: vcId },
      });
      expect(deleted).toBeNull();
    });

    it('AC1: allowedAuthors is a JSON string field', async () => {
      const project = await prisma.project.create({
        data: { name: 'JsonTest', slug: 'json-test', key: 'JSON' },
      });

      const authors = JSON.stringify(['user1', 'user2', 'user3']);
      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: authors,
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      expect(vc.allowedAuthors).toBe(authors);
      expect(() => JSON.parse(vc.allowedAuthors)).not.toThrow();

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vc.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: webhookSecret is nullable', async () => {
      const project = await prisma.project.create({
        data: { name: 'WebhookTest', slug: 'webhook-test', key: 'WEBH' },
      });

      const vc1 = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret123',
          isActive: true,
        },
      });

      expect(vc1.webhookSecret).toBe('secret123');

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vc1.id } });

      // Can also create without webhookSecret
      const project2 = await prisma.project.create({
        data: { name: 'NoWebhookTest', slug: 'no-webhook-test', key: 'NOWH' },
      });

      const vc2 = await prisma.vcsConnection.create({
        data: {
          projectId: project2.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          isActive: true,
        },
      });

      expect(vc2.webhookSecret).toBeNull();

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vc2.id } });
      await prisma.project.delete({ where: { id: project.id } });
      await prisma.project.delete({ where: { id: project2.id } });
    });
  });

  describe('VcsSyncLog model schema validation', () => {
    it('AC2: model exists with all required fields', async () => {
      expect(prisma.vcsSyncLog).toBeDefined();

      const project = await prisma.project.create({
        data: { name: 'SyncLogTest', slug: 'sync-log-test', key: 'SLGT' },
      });

      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const now = new Date();
      const log = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vc.id,
          syncType: 'issues',
          issuesSynced: 42,
          issuesSkipped: 5,
          errorMessage: null,
          startedAt: now,
          completedAt: now,
        },
      });

      // Validate all fields
      expect(log.id).toBeDefined();
      expect(log.vcsConnectionId).toBe(vc.id);
      expect(log.syncType).toBe('issues');
      expect(log.issuesSynced).toBe(42);
      expect(log.issuesSkipped).toBe(5);
      expect(log.errorMessage).toBeNull();
      expect(log.startedAt).toEqual(now);
      expect(log.completedAt).toEqual(now);

      // Cleanup
      await prisma.vcsSyncLog.delete({ where: { id: log.id } });
      await prisma.vcsConnection.delete({ where: { id: vc.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC2: errorMessage is nullable', async () => {
      const project = await prisma.project.create({
        data: { name: 'ErrorMsgTest', slug: 'error-msg-test', key: 'ERRT' },
      });

      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const logWithError = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vc.id,
          syncType: 'issues',
          issuesSynced: 0,
          issuesSkipped: 0,
          errorMessage: 'API rate limit exceeded',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      expect(logWithError.errorMessage).toBe('API rate limit exceeded');

      // Cleanup
      await prisma.vcsSyncLog.delete({ where: { id: logWithError.id } });

      const logWithoutError = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vc.id,
          syncType: 'prs',
          issuesSynced: 10,
          issuesSkipped: 0,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      expect(logWithoutError.errorMessage).toBeNull();

      // Cleanup
      await prisma.vcsSyncLog.delete({ where: { id: logWithoutError.id } });
      await prisma.vcsConnection.delete({ where: { id: vc.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC2: cascade delete when VcsConnection is deleted', async () => {
      const project = await prisma.project.create({
        data: { name: 'CascadeLogTest', slug: 'cascade-log-test', key: 'CLGT' },
      });

      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const log = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vc.id,
          syncType: 'issues',
          issuesSynced: 5,
          issuesSkipped: 1,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      const logId = log.id;

      // Delete VcsConnection
      await prisma.vcsConnection.delete({ where: { id: vc.id } });

      // VcsSyncLog should be cascade deleted
      const deleted = await prisma.vcsSyncLog.findUnique({
        where: { id: logId },
      });
      expect(deleted).toBeNull();

      // Cleanup
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('Ticket model extensions validation', () => {
    it('AC3: has externalVcsId, externalVcsUrl, and vcsSyncedAt fields', async () => {
      const project = await prisma.project.create({
        data: { name: 'TicketVcsTest', slug: 'ticket-vcs-test', key: 'TVCS' },
      });

      const ticket = await prisma.ticket.create({
        data: {
          projectId: project.id,
          number: 1,
          type: 'BUG',
          title: 'Test ticket with VCS fields',
          externalVcsId: 'github-12345',
          externalVcsUrl: 'https://github.com/owner/repo/issues/42',
          vcsSyncedAt: new Date(),
        },
      });

      expect(ticket.externalVcsId).toBe('github-12345');
      expect(ticket.externalVcsUrl).toBe('https://github.com/owner/repo/issues/42');
      expect(ticket.vcsSyncedAt).toBeInstanceOf(Date);

      // Cleanup
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC3: all VCS fields are nullable', async () => {
      const project = await prisma.project.create({
        data: { name: 'TicketNullTest', slug: 'ticket-null-test', key: 'TNUL' },
      });

      const ticket = await prisma.ticket.create({
        data: {
          projectId: project.id,
          number: 1,
          type: 'ENHANCEMENT',
          title: 'Ticket without VCS sync',
        },
      });

      expect(ticket.externalVcsId).toBeNull();
      expect(ticket.externalVcsUrl).toBeNull();
      expect(ticket.vcsSyncedAt).toBeNull();

      // Cleanup
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('Project model extensions validation', () => {
    it('AC4: has one-to-one optional vcsConnection relation with cascade delete', async () => {
      const project = await prisma.project.create({
        data: { name: 'ProjectVcsTest', slug: 'project-vcs-test', key: 'PVCS' },
      });

      // Initially no vcsConnection
      let proj = await prisma.project.findUnique({
        where: { id: project.id },
        include: { vcsConnection: true },
      });
      expect(proj.vcsConnection).toBeNull();

      // Create VcsConnection
      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      // Now project has vcsConnection
      proj = await prisma.project.findUnique({
        where: { id: project.id },
        include: { vcsConnection: true },
      });
      expect(proj.vcsConnection).toBeDefined();
      expect(proj.vcsConnection.id).toBe(vc.id);

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vc.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC4: vcsConnection cascade delete on project deletion', async () => {
      const project = await prisma.project.create({
        data: { name: 'ProjectCascadeTest', slug: 'project-cascade-test', key: 'PCAS' },
      });

      const vc = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const vcId = vc.id;

      // Delete project
      await prisma.project.delete({ where: { id: project.id } });

      // VcsConnection should be cascade deleted
      const deleted = await prisma.vcsConnection.findUnique({
        where: { id: vcId },
      });
      expect(deleted).toBeNull();
    });
  });
});
