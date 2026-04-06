/**
 * VCS Prisma Models Integration Tests
 *
 * Verifies that VcsConnection and VcsSyncLog models exist in the schema
 * and that Ticket/Project models have been properly extended with VCS fields.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/prisma-models.integration.spec.ts
 */

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('VCS Prisma Models', () => {
  let prisma: PrismaClient;
  let tmpDbPath: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    // Create temporary test database
    tmpDbPath = path.join(os.tmpdir(), `koda-vcs-test-${Date.now()}.db`);

    // Initialize Prisma client for test database
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: `file:${tmpDbPath}`,
        },
      },
    });

    // Apply migrations to set up the schema
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

  describe('VcsConnection model', () => {
    it('should have VcsConnection model available', async () => {
      // Verify that the model exists and can be queried
      expect(prisma.vcsConnection).toBeDefined();
    });

    it('should support creating a VcsConnection with all required fields', async () => {
      // Create a project first
      const project = await prisma.project.create({
        data: {
          name: 'Test Project',
          slug: 'test-project',
          key: 'TEST',
        },
      });

      // Create VcsConnection
      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'test-owner',
          repoName: 'test-repo',
          encryptedToken: 'encrypted_token_value',
          syncMode: 'POLL',
          allowedAuthors: JSON.stringify(['user1', 'user2']),
          pollingIntervalMs: 300000,
          webhookSecret: 'secret123',
          isActive: true,
        },
      });

      expect(vcsConnection).toBeDefined();
      expect(vcsConnection.id).toBeDefined();
      expect(vcsConnection.projectId).toBe(project.id);
      expect(vcsConnection.provider).toBe('github');
      expect(vcsConnection.repoOwner).toBe('test-owner');
      expect(vcsConnection.repoName).toBe('test-repo');
      expect(vcsConnection.encryptedToken).toBe('encrypted_token_value');
      expect(vcsConnection.syncMode).toBe('POLL');
      expect(vcsConnection.allowedAuthors).toBe(JSON.stringify(['user1', 'user2']));
      expect(vcsConnection.pollingIntervalMs).toBe(300000);
      expect(vcsConnection.webhookSecret).toBe('secret123');
      expect(vcsConnection.isActive).toBe(true);
      expect(vcsConnection.createdAt).toBeInstanceOf(Date);
      expect(vcsConnection.updatedAt).toBeInstanceOf(Date);
      expect(vcsConnection.lastSyncedAt).toBeNull();

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vcsConnection.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should enforce unique constraint on projectId', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 2',
          slug: 'test-project-2',
          key: 'TST2',
        },
      });

      const vcsConnection1 = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner1',
          repoName: 'repo1',
          encryptedToken: 'token1',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret1',
          isActive: true,
        },
      });

      // Attempting to create a second VcsConnection for the same project should fail
      await expect(
        prisma.vcsConnection.create({
          data: {
            projectId: project.id,
            provider: 'gitlab',
            repoOwner: 'owner2',
            repoName: 'repo2',
            encryptedToken: 'token2',
            syncMode: 'POLL',
            allowedAuthors: '[]',
            pollingIntervalMs: 300000,
            webhookSecret: 'secret2',
            isActive: true,
          },
        }),
      ).rejects.toThrow();

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vcsConnection1.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should cascade delete VcsConnection when Project is deleted', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 3',
          slug: 'test-project-3',
          key: 'TST3',
        },
      });

      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const vcsConnectionId = vcsConnection.id;

      // Delete the project (using deletedAt soft delete)
      await prisma.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });

      // VcsConnection should still exist (soft delete behavior is at project level)
      // but hard delete of project should cascade
      await prisma.project.delete({ where: { id: project.id } });

      // Verify VcsConnection is deleted
      const deletedConnection = await prisma.vcsConnection.findUnique({
        where: { id: vcsConnectionId },
      });
      expect(deletedConnection).toBeNull();
    });

    it('should support updating lastSyncedAt timestamp', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 4',
          slug: 'test-project-4',
          key: 'TST4',
        },
      });

      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const now = new Date();
      const updated = await prisma.vcsConnection.update({
        where: { id: vcsConnection.id },
        data: { lastSyncedAt: now },
      });

      expect(updated.lastSyncedAt).toEqual(expect.any(Date));

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vcsConnection.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('VcsSyncLog model', () => {
    it('should have VcsSyncLog model available', async () => {
      expect(prisma.vcsSyncLog).toBeDefined();
    });

    it('should support creating a VcsSyncLog with all required fields', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 5',
          slug: 'test-project-5',
          key: 'TST5',
        },
      });

      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const syncLog = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vcsConnection.id,
          syncType: 'FULL',
          issuesSynced: 42,
          issuesSkipped: 5,
          errorMessage: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      expect(syncLog).toBeDefined();
      expect(syncLog.id).toBeDefined();
      expect(syncLog.vcsConnectionId).toBe(vcsConnection.id);
      expect(syncLog.syncType).toBe('FULL');
      expect(syncLog.issuesSynced).toBe(42);
      expect(syncLog.issuesSkipped).toBe(5);
      expect(syncLog.errorMessage).toBeNull();
      expect(syncLog.startedAt).toBeInstanceOf(Date);
      expect(syncLog.completedAt).toBeInstanceOf(Date);

      // Cleanup
      await prisma.vcsSyncLog.delete({ where: { id: syncLog.id } });
      await prisma.vcsConnection.delete({ where: { id: vcsConnection.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should support optional errorMessage field', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 6',
          slug: 'test-project-6',
          key: 'TST6',
        },
      });

      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const syncLog = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vcsConnection.id,
          syncType: 'INCREMENTAL',
          issuesSynced: 10,
          issuesSkipped: 2,
          errorMessage: 'API rate limit exceeded',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      expect(syncLog.errorMessage).toBe('API rate limit exceeded');

      // Cleanup
      await prisma.vcsSyncLog.delete({ where: { id: syncLog.id } });
      await prisma.vcsConnection.delete({ where: { id: vcsConnection.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should cascade delete VcsSyncLog when VcsConnection is deleted', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 7',
          slug: 'test-project-7',
          key: 'TST7',
        },
      });

      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const syncLog = await prisma.vcsSyncLog.create({
        data: {
          vcsConnectionId: vcsConnection.id,
          syncType: 'FULL',
          issuesSynced: 0,
          issuesSkipped: 0,
          errorMessage: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      const syncLogId = syncLog.id;

      // Delete the VcsConnection
      await prisma.vcsConnection.delete({ where: { id: vcsConnection.id } });

      // Verify VcsSyncLog is deleted
      const deletedLog = await prisma.vcsSyncLog.findUnique({
        where: { id: syncLogId },
      });
      expect(deletedLog).toBeNull();

      // Cleanup
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('Ticket model extensions', () => {
    it('should have externalVcsId, externalVcsUrl, and vcsSyncedAt fields', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 8',
          slug: 'test-project-8',
          key: 'TST8',
        },
      });

      const ticket = await prisma.ticket.create({
        data: {
          projectId: project.id,
          number: 1,
          type: 'BUG',
          title: 'Test ticket with VCS fields',
          externalVcsId: 'github-issue-12345',
          externalVcsUrl: 'https://github.com/owner/repo/issues/42',
          vcsSyncedAt: new Date(),
        },
      });

      expect(ticket.externalVcsId).toBe('github-issue-12345');
      expect(ticket.externalVcsUrl).toBe('https://github.com/owner/repo/issues/42');
      expect(ticket.vcsSyncedAt).toBeInstanceOf(Date);

      // Cleanup
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should allow nullable VCS fields', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 9',
          slug: 'test-project-9',
          key: 'TST9',
        },
      });

      const ticket = await prisma.ticket.create({
        data: {
          projectId: project.id,
          number: 1,
          type: 'TASK',
          title: 'Ticket without VCS sync',
          // VCS fields are not set (nullable)
        },
      });

      expect(ticket.externalVcsId).toBeNull();
      expect(ticket.externalVcsUrl).toBeNull();
      expect(ticket.vcsSyncedAt).toBeNull();

      // Cleanup
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should support updating Ticket VCS fields', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 10',
          slug: 'test-project-10',
          key: 'TS10',
        },
      });

      const ticket = await prisma.ticket.create({
        data: {
          projectId: project.id,
          number: 1,
          type: 'ENHANCEMENT',
          title: 'Test ticket for update',
        },
      });

      const updated = await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          externalVcsId: 'github-issue-99999',
          externalVcsUrl: 'https://github.com/owner/repo/issues/99',
          vcsSyncedAt: new Date(),
        },
      });

      expect(updated.externalVcsId).toBe('github-issue-99999');
      expect(updated.externalVcsUrl).toBe('https://github.com/owner/repo/issues/99');
      expect(updated.vcsSyncedAt).toBeInstanceOf(Date);

      // Cleanup
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('Project model extensions', () => {
    it('should have optional one-to-one vcsConnection relation', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 11',
          slug: 'test-project-11',
          key: 'TS11',
        },
      });

      // Initially, project should have no vcsConnection
      const projectWithoutVcs = await prisma.project.findUnique({
        where: { id: project.id },
        include: { vcsConnection: true },
      });

      expect(projectWithoutVcs.vcsConnection).toBeNull();

      // Create a VcsConnection for the project
      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      // Now project should include vcsConnection
      const projectWithVcs = await prisma.project.findUnique({
        where: { id: project.id },
        include: { vcsConnection: true },
      });

      expect(projectWithVcs.vcsConnection).toBeDefined();
      expect(projectWithVcs.vcsConnection.id).toBe(vcsConnection.id);

      // Cleanup
      await prisma.vcsConnection.delete({ where: { id: vcsConnection.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('should cascade delete vcsConnection when Project is hard-deleted', async () => {
      const project = await prisma.project.create({
        data: {
          name: 'Test Project 12',
          slug: 'test-project-12',
          key: 'TS12',
        },
      });

      const vcsConnection = await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'token',
          syncMode: 'POLL',
          allowedAuthors: '[]',
          pollingIntervalMs: 300000,
          webhookSecret: 'secret',
          isActive: true,
        },
      });

      const vcsConnectionId = vcsConnection.id;

      // Delete the project
      await prisma.project.delete({ where: { id: project.id } });

      // Verify VcsConnection is cascade deleted
      const deletedVcsConnection = await prisma.vcsConnection.findUnique({
        where: { id: vcsConnectionId },
      });
      expect(deletedVcsConnection).toBeNull();
    });
  });
});
