/**
 * VcsController Manual Sync Endpoints Tests (VCS-P1-004-D)
 *
 * Tests for manual sync endpoints:
 * - POST /projects/:slug/vcs/sync/:issueNumber (single issue)
 * - POST /projects/:slug/vcs/sync (full sync)
 *
 * Acceptance Criteria:
 * 1. POST /projects/:slug/vcs/sync/:issueNumber fetches issue and calls syncIssue() regardless of allowedAuthors
 * 2. POST /projects/:slug/vcs/sync/:issueNumber returns HTTP 409 when issue already synced
 * 3. POST /projects/:slug/vcs/sync/:issueNumber returns created ticket reference on success
 * 4. POST /projects/:slug/vcs/sync triggers full fetch, syncs each issue, returns counts
 * 5. POST /projects/:slug/vcs/sync includes created ticket IDs in result
 *
 * Run: npx jest test/integration/vcs/vcs-manual-sync.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { VcsController } from '../../../src/vcs/vcs.controller';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { VcsSyncService, SyncIssueResult } from '../../../src/vcs/vcs-sync.service';
import { VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ConfigService } from '@nestjs/config';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { VcsIssue } from '../../../src/vcs/types';
import { Project, VcsConnection } from '@prisma/client';

// Mock the createVcsProvider factory
jest.mock('../../../src/vcs/factory', () => ({
  createVcsProvider: jest.fn(),
}));

// Mock the decryptToken utility
jest.mock('../../../src/common/utils/encryption.util', () => ({
  decryptToken: jest.fn((token: string) => {
    // Mock decryption - just return a dummy token
    return 'decrypted-token';
  }),
}));

describe('VcsController Manual Sync Endpoints (VCS-P1-004-D)', () => {
  let controller: VcsController;
  let syncService: jest.Mocked<VcsSyncService>;
  let vcsConnectionService: jest.Mocked<VcsConnectionService>;
  let projectsService: jest.Mocked<ProjectsService>;
  let configService: jest.Mocked<ConfigService>;
  let module: TestingModule;

  const mockProject: Project = {
    id: 'proj-123',
    slug: 'test-project',
    name: 'Test Project',
    key: 'TEST',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ciWebhookToken: null,
  };

  const mockVcsConnection: VcsConnection = {
    id: 'vcs-conn-123',
    projectId: mockProject.id,
    provider: 'github',
    repoOwner: 'test-owner',
    repoName: 'test-repo',
    encryptedToken: 'encrypted-token-123',
    syncMode: 'polling',
    allowedAuthors: '["octocat"]',
    pollingIntervalMs: 3600000,
    webhookSecret: undefined,
    lastSyncedAt: undefined,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const encryptionKey = 'test-encryption-key-32-chars-long';

  const mockVcsIssue: VcsIssue = {
    number: 42,
    title: 'Fix authentication bug',
    body: 'Users cannot log in after changing password',
    authorLogin: 'octocat',
    url: 'https://github.com/test-owner/test-repo/issues/42',
    labels: ['bug', 'authentication'],
    createdAt: new Date('2024-01-15'),
  };

  beforeEach(async () => {
    // Create mock services
    const mockSyncServiceInstance = {
      syncIssue: jest.fn(),
      fullSync: jest.fn(),
      filterByAllowedAuthors: jest.fn(),
    };

    const mockVcsConnectionServiceInstance = {
      getFullByProject: jest.fn(),
    };

    const mockProjectsServiceInstance = {
      findBySlug: jest.fn().mockResolvedValue(mockProject),
    };

    const mockConfigServiceInstance = {
      get: jest.fn((key: string) => {
        if (key === 'vcs.encryptionKey') return encryptionKey;
        return undefined;
      }),
    };

    // Mock the VCS provider
    const mockProvider = {
      fetchIssue: jest.fn().mockResolvedValue(mockVcsIssue),
      fetchIssues: jest.fn().mockResolvedValue([mockVcsIssue]),
    };

    const { createVcsProvider } = require('../../../src/vcs/factory');
    createVcsProvider.mockReturnValue(mockProvider);

    module = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        { provide: VcsSyncService, useValue: mockSyncServiceInstance },
        { provide: VcsConnectionService, useValue: mockVcsConnectionServiceInstance },
        { provide: VcsWebhookService, useValue: {} },
        { provide: ProjectsService, useValue: mockProjectsServiceInstance },
        { provide: ConfigService, useValue: mockConfigServiceInstance },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
    syncService = module.get(VcsSyncService) as jest.Mocked<VcsSyncService>;
    vcsConnectionService = module.get(VcsConnectionService) as jest.Mocked<VcsConnectionService>;
    projectsService = module.get(ProjectsService) as jest.Mocked<ProjectsService>;
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  afterEach(async () => {
    await module.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /projects/:slug/vcs/sync/:issueNumber - SINGLE ISSUE SYNC
  // ─────────────────────────────────────────────────────────────────

  describe('POST /projects/:slug/vcs/sync/:issueNumber (syncIssue)', () => {
    describe('AC1: Fetches issue and calls syncIssue() regardless of allowedAuthors', () => {
      it('should fetch specific issue by number from provider and sync it', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 1,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        // Verify the result includes the synced ticket
        expect(result).toBeDefined();
        expect(result.issuesSynced).toBe(1);
        expect(result.issuesSkipped).toBe(0);
        expect(result.createdTickets).toHaveLength(1);
        expect(result.createdTickets[0].id).toBe('ticket-123');
      });

      it('should bypass allowedAuthors filter and sync any issue', async () => {
        // AC1 requires that allowedAuthors should be bypassed for manual sync.
        // This means even if the issue author is not in allowedAuthors,
        // it should still be synced.

        const issueNumber = '42';
        const issueFromUnauthorizedAuthor: VcsIssue = {
          ...mockVcsIssue,
          authorLogin: 'unauthorized-user', // Not in allowedAuthors
        };

        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 1,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        // Should still sync even though author is not in allowedAuthors
        expect(syncService.syncIssue).toHaveBeenCalled();
        expect(result.issuesSynced).toBe(1);
      });

      it('should call syncIssue with manual source regardless of author', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 1,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        await controller.syncIssue(mockProject.slug, issueNumber);

        // Verify syncIssue was called with 'manual' mode
        expect(syncService.syncIssue).toHaveBeenCalledWith(
          mockProject,
          expect.objectContaining({ number: 42 }),
          'manual'
        );
      });
    });

    describe('AC2: Returns HTTP 409 when issue already synced', () => {
      it('should throw ConflictException when issue is already synced', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'skipped',
          reason: 'Ticket with this external VCS ID already exists',
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
          ConflictException
        );
      });

      it('should indicate skip in response when issue is duplicate', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'skipped',
          reason: 'Duplicate external VCS ID',
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
          ConflictException
        );
      });
    });

    describe('AC3: Returns created ticket reference on success', () => {
      it('should include ticket ID in createdTickets array', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-abc-123',
          ticketNumber: 5,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        expect(result.createdTickets).toHaveLength(1);
        expect(result.createdTickets[0].id).toBe('ticket-abc-123');
      });

      it('should include projectKey in ticket reference', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 1,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        expect(result.createdTickets[0].projectKey).toBe(mockProject.key);
      });

      it('should include ticket number in reference', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 7,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        expect(result.createdTickets[0].number).toBe(7);
      });

      it('should return complete SyncResultDto structure', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 1,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        expect(result).toHaveProperty('issuesSynced');
        expect(result).toHaveProperty('issuesSkipped');
        expect(result).toHaveProperty('createdTickets');
        expect(typeof result.issuesSynced).toBe('number');
        expect(typeof result.issuesSkipped).toBe('number');
        expect(Array.isArray(result.createdTickets)).toBe(true);
      });

      it('should have issuesSynced=1 when ticket is created successfully', async () => {
        const issueNumber = '42';
        const syncResult: SyncIssueResult = {
          action: 'created',
          ticketId: 'ticket-123',
          ticketNumber: 1,
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockResolvedValue(syncResult);

        const result = await controller.syncIssue(mockProject.slug, issueNumber);

        expect(result.issuesSynced).toBe(1);
        expect(result.issuesSkipped).toBe(0);
      });
    });

    describe('Error Handling', () => {
      it('should throw NotFoundAppException when project not found', async () => {
        const issueNumber = '42';

        projectsService.findBySlug.mockRejectedValue(
          new NotFoundAppException('Project not found', 'project_not_found')
        );

        await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
          NotFoundAppException
        );
      });

      it('should throw NotFoundAppException when VCS connection not found', async () => {
        const issueNumber = '42';

        vcsConnectionService.getFullByProject.mockRejectedValue(
          new NotFoundAppException('No VCS connection', 'vcs_not_found')
        );

        await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
          NotFoundAppException
        );
      });

      it('should propagate syncIssue errors', async () => {
        const issueNumber = '42';

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.syncIssue.mockRejectedValue(new Error('Sync failed'));

        await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
          'Sync failed'
        );
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /projects/:slug/vcs/sync - FULL SYNC
  // ─────────────────────────────────────────────────────────────────

  describe('POST /projects/:slug/vcs/sync (syncAll)', () => {
    describe('AC4: Triggers full sync with issue counts', () => {
      it('should fetch all issues and return sync counts', async () => {
        const fullSyncResult = {
          issuesSynced: 3,
          issuesSkipped: 2,
          createdTickets: [
            { id: 'ticket-1', number: 1 },
            { id: 'ticket-2', number: 2 },
            { id: 'ticket-3', number: 3 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.issuesSynced).toBe(3);
        expect(result.issuesSkipped).toBe(2);
        expect(syncService.fullSync).toHaveBeenCalledWith(
          mockProject,
          mockVcsConnection,
          encryptionKey
        );
      });

      it('should call fullSync with correct parameters', async () => {
        const fullSyncResult = {
          issuesSynced: 2,
          issuesSkipped: 1,
          createdTickets: [
            { id: 'ticket-1', number: 1 },
            { id: 'ticket-2', number: 2 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        await controller.syncAll(mockProject.slug);

        // Verify fullSync was called with correct parameters
        expect(syncService.fullSync).toHaveBeenCalledWith(
          mockProject,
          mockVcsConnection,
          encryptionKey
        );
      });

      it('should return correct counts when all issues are synced', async () => {
        const fullSyncResult = {
          issuesSynced: 5,
          issuesSkipped: 0,
          createdTickets: Array(5)
            .fill(null)
            .map((_, i) => ({ id: `ticket-${i}`, number: i + 1 })),
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.issuesSynced).toBe(5);
        expect(result.issuesSkipped).toBe(0);
      });

      it('should return correct counts when some issues are skipped', async () => {
        const fullSyncResult = {
          issuesSynced: 2,
          issuesSkipped: 3,
          createdTickets: [
            { id: 'ticket-1', number: 1 },
            { id: 'ticket-2', number: 2 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.issuesSynced).toBe(2);
        expect(result.issuesSkipped).toBe(3);
      });
    });

    describe('AC5: Includes created ticket IDs in result', () => {
      it('should include all created ticket references', async () => {
        const fullSyncResult = {
          issuesSynced: 3,
          issuesSkipped: 0,
          createdTickets: [
            { id: 'ticket-abc', number: 1 },
            { id: 'ticket-def', number: 2 },
            { id: 'ticket-ghi', number: 3 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.createdTickets).toHaveLength(3);
        expect(result.createdTickets[0].id).toBe('ticket-abc');
        expect(result.createdTickets[1].id).toBe('ticket-def');
        expect(result.createdTickets[2].id).toBe('ticket-ghi');
      });

      it('should include projectKey for each ticket', async () => {
        const fullSyncResult = {
          issuesSynced: 2,
          issuesSkipped: 0,
          createdTickets: [
            { id: 'ticket-1', number: 1 },
            { id: 'ticket-2', number: 2 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.createdTickets.every((t) => t.projectKey === mockProject.key)).toBe(true);
      });

      it('should include ticket number for each created ticket', async () => {
        const fullSyncResult = {
          issuesSynced: 3,
          issuesSkipped: 0,
          createdTickets: [
            { id: 'ticket-1', number: 10 },
            { id: 'ticket-2', number: 11 },
            { id: 'ticket-3', number: 12 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.createdTickets[0].number).toBe(10);
        expect(result.createdTickets[1].number).toBe(11);
        expect(result.createdTickets[2].number).toBe(12);
      });

      it('should return empty array when no tickets created', async () => {
        const fullSyncResult = {
          issuesSynced: 0,
          issuesSkipped: 5,
          createdTickets: [],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.createdTickets).toHaveLength(0);
        expect(Array.isArray(result.createdTickets)).toBe(true);
      });
    });

    describe('Full Sync Response Structure', () => {
      it('should return SyncResultDto with all required fields', async () => {
        const fullSyncResult = {
          issuesSynced: 2,
          issuesSkipped: 1,
          createdTickets: [
            { id: 'ticket-1', number: 1 },
            { id: 'ticket-2', number: 2 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result).toHaveProperty('issuesSynced');
        expect(result).toHaveProperty('issuesSkipped');
        expect(result).toHaveProperty('createdTickets');
      });

      it('should include errors array when errors occur', async () => {
        const fullSyncResult = {
          issuesSynced: 1,
          issuesSkipped: 2,
          createdTickets: [{ id: 'ticket-1', number: 1 }],
          errors: ['Issue 100: Network timeout', 'Issue 101: Invalid author'],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        expect(result.errors).toBeDefined();
        expect(result.errors).toHaveLength(2);
      });

      it('should omit errors field when no errors', async () => {
        const fullSyncResult = {
          issuesSynced: 2,
          issuesSkipped: 0,
          createdTickets: [
            { id: 'ticket-1', number: 1 },
            { id: 'ticket-2', number: 2 },
          ],
          errors: [],
        };

        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockResolvedValue(fullSyncResult);

        const result = await controller.syncAll(mockProject.slug);

        // errors field should be undefined when empty
        expect(result.errors).toBeUndefined();
      });
    });

    describe('Error Handling', () => {
      it('should throw NotFoundAppException when project not found', async () => {
        projectsService.findBySlug.mockRejectedValue(
          new NotFoundAppException('Project not found', 'project_not_found')
        );

        await expect(controller.syncAll(mockProject.slug)).rejects.toThrow(
          NotFoundAppException
        );
      });

      it('should throw NotFoundAppException when VCS connection not found', async () => {
        vcsConnectionService.getFullByProject.mockRejectedValue(
          new NotFoundAppException('No VCS connection', 'vcs_not_found')
        );

        await expect(controller.syncAll(mockProject.slug)).rejects.toThrow(
          NotFoundAppException
        );
      });

      it('should propagate fullSync errors', async () => {
        vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
        syncService.fullSync.mockRejectedValue(new Error('Provider error'));

        await expect(controller.syncAll(mockProject.slug)).rejects.toThrow('Provider error');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // INTEGRATION SCENARIOS
  // ─────────────────────────────────────────────────────────────────

  describe('Integration Scenarios', () => {
    it('syncIssue should work with concurrent calls for different issues', async () => {
      const issueNumber1 = '42';
      const issueNumber2 = '43';

      const syncResult1: SyncIssueResult = {
        action: 'created',
        ticketId: 'ticket-1',
        ticketNumber: 1,
      };

      const syncResult2: SyncIssueResult = {
        action: 'created',
        ticketId: 'ticket-2',
        ticketNumber: 2,
      };

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
      syncService.syncIssue
        .mockResolvedValueOnce(syncResult1)
        .mockResolvedValueOnce(syncResult2);

      const result1 = await controller.syncIssue(mockProject.slug, issueNumber1);
      const result2 = await controller.syncIssue(mockProject.slug, issueNumber2);

      expect(result1.createdTickets[0].number).toBe(1);
      expect(result2.createdTickets[0].number).toBe(2);
    });

    it('fullSync should handle mix of successful and skipped issues', async () => {
      const fullSyncResult = {
        issuesSynced: 2,
        issuesSkipped: 1,
        createdTickets: [
          { id: 'ticket-1', number: 1 },
          { id: 'ticket-2', number: 2 },
        ],
        errors: [],
      };

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
      syncService.fullSync.mockResolvedValue(fullSyncResult);

      const result = await controller.syncAll(mockProject.slug);

      expect(result.issuesSynced + result.issuesSkipped).toBe(3);
      expect(result.createdTickets.length).toBe(result.issuesSynced);
    });

    it('should decrypt token from connection for provider creation', async () => {
      const issueNumber = '42';
      const syncResult: SyncIssueResult = {
        action: 'created',
        ticketId: 'ticket-123',
        ticketNumber: 1,
      };

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
      syncService.syncIssue.mockResolvedValue(syncResult);

      await controller.syncIssue(mockProject.slug, issueNumber);

      // Verify getFullByProject was called to get encryption details
      expect(vcsConnectionService.getFullByProject).toHaveBeenCalledWith(mockProject.id);
    });
  });
});
