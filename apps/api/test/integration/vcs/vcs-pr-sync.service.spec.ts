/**
 * VcsPrSyncService.syncPrStatus Unit/Integration Tests
 *
 * Tests for the VcsPrSyncService that syncs PR status from VCS provider
 * to TicketLink records. Covers:
 * - Querying TicketLink entries with active PRs (prNumber IS NOT NULL, prState NOT IN ('merged', 'closed'))
 * - Fetching current PR status from VCS provider
 * - Updating TicketLink.prState and prUpdatedAt when state differs
 * - Per-PR error handling (skip on general API error, mark 'closed' on 404)
 * - Return summary of updated and skipped counts
 *
 * Run: npx jest test/integration/vcs/vcs-pr-sync.service.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { VcsPrStatus } from '../../../src/vcs/types';

// Mock the decryptToken utility
jest.mock('../../../src/common/utils/encryption.util', () => ({
  decryptToken: jest.fn((token: string) => {
    // Mock decryption - just return a dummy token
    return 'decrypted-token';
  }),
}));

// Mock the VCS factory
jest.mock('../../../src/vcs/factory', () => ({
  createVcsProvider: jest.fn(),
}));

// Import the service - will fail to compile if service doesn't exist yet
import { VcsPrSyncService, SyncPrStatusResult } from '../../../src/vcs/vcs-pr-sync.service';

describe('VcsPrSyncService.syncPrStatus', () => {
  let service: VcsPrSyncService;
  let prismaService: PrismaService;
  let module: TestingModule;

  const projectId = 'project-123';

  const mockProject = {
    id: projectId,
    name: 'Test Project',
    slug: 'test-project',
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

  const mockVcsConnection = {
    id: 'vcs-conn-1',
    projectId,
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'encrypted-token',
    syncMode: 'manual',
    allowedAuthors: '[]',
    pollingIntervalMs: 60000,
    webhookSecret: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Mock TicketLink entries with active PRs
  const mockTicketLinks = [
    {
      id: 'link-1',
      ticketId: 'ticket-1',
      url: 'https://github.com/owner/repo/pull/101',
      provider: 'github',
      externalRef: 'owner/repo#101',
      prState: 'open',
      prNumber: 101,
      prUpdatedAt: new Date('2024-01-01'),
      createdAt: new Date(),
    },
    {
      id: 'link-2',
      ticketId: 'ticket-2',
      url: 'https://github.com/owner/repo/pull/102',
      provider: 'github',
      externalRef: 'owner/repo#102',
      prState: 'draft',
      prNumber: 102,
      prUpdatedAt: new Date('2024-01-02'),
      createdAt: new Date(),
    },
    {
      id: 'link-3',
      ticketId: 'ticket-3',
      url: 'https://github.com/owner/repo/pull/103',
      provider: 'github',
      externalRef: 'owner/repo#103',
      prState: 'open',
      prNumber: 103,
      prUpdatedAt: new Date('2024-01-03'),
      createdAt: new Date(),
    },
  ];

  const mockTicketLinkDelegate = {
    findMany: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
  };

  const mockVcsProvider = {
    getPullRequestStatus: jest.fn(),
    fetchIssues: jest.fn(),
    fetchIssue: jest.fn(),
    testConnection: jest.fn(),
    getDefaultBranch: jest.fn(),
    createPullRequest: jest.fn(),
    listPullRequests: jest.fn(),
  };

  const mockClient = {
    ticketLink: { ...mockTicketLinkDelegate },
    $transaction: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    // Set up factory mock to return mockVcsProvider
    const { createVcsProvider } = require('../../../src/vcs/factory');
    createVcsProvider.mockReturnValue(mockVcsProvider);

    module = await Test.createTestingModule({
      providers: [
        VcsPrSyncService,
        {
          provide: PrismaService,
          useValue: {
            client: mockClient,
          },
        },
      ],
    }).compile();

    service = module.get<VcsPrSyncService>(VcsPrSyncService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('AC1: ActivityType enum includes VCS_PR_MERGED', () => {
    it('should have VCS_PR_MERGED in ActivityType', async () => {
      const { ActivityType } = await import('../../../src/common/enums');
      expect(ActivityType.VCS_PR_MERGED).toBe('VCS_PR_MERGED');
    });

    it('should have VCS_PR_CREATED from previous work', async () => {
      const { ActivityType } = await import('../../../src/common/enums');
      expect(ActivityType.VCS_PR_CREATED).toBe('VCS_PR_CREATED');
    });
  });

  describe('AC2: Queries TicketLink entries with active PRs', () => {
    it('should query TicketLink where prNumber IS NOT NULL and prState NOT IN ("merged", "closed")', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([]);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(mockTicketLinkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            prNumber: { not: null },
            prState: { notIn: ['merged', 'closed'] },
          }),
        }),
      );
    });

    it('should scope query to tickets in the given project via ticket relation', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([]);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should filter by project through the ticket relation
      expect(mockTicketLinkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ticket: {
              projectId: projectId,
              deletedAt: null,
            },
          }),
        }),
      );
    });

    it('should return empty array when no active PRs found', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([]);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('AC3: Calls VCS provider to fetch current PR status', () => {
    it('should call getPullRequestStatus for each matching TicketLink', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce(mockTicketLinks);

      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce({
        number: 101,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/101',
        title: 'PR 101',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledWith(101);
      expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledWith(102);
      expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledWith(103);
    });

    it('should decrypt the VCS connection token before creating provider', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([]);
      const decryptToken = jest.requireMock('../../../src/common/utils/encryption.util').decryptToken;
      decryptToken.mockReturnValueOnce('decrypted-token');

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(decryptToken).toHaveBeenCalledWith(mockVcsConnection.encryptedToken, 'encryption-key');
    });
  });

  describe('AC4: Updates TicketLink when state differs', () => {
    it('should update prState and prUpdatedAt when fetched state differs from stored', async () => {
      // PR 101 changed from 'open' to 'merged'
      const mergedPrStatus: VcsPrStatus = {
        number: 101,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-02-01'),
        mergedBy: 'octocat',
        mergeSha: 'abc123',
        url: 'https://github.com/owner/repo/pull/101',
        title: 'PR 101',
      };

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);
      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'merged',
        prUpdatedAt: expect.any(Date),
      });

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: {
          prState: 'merged',
          prUpdatedAt: expect.any(Date),
        },
      });
      expect(result.updated).toBe(1);
    });

    it('should NOT update if fetched state is the same as stored', async () => {
      // PR 101 still 'open'
      const openPrStatus: VcsPrStatus = {
        number: 101,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/101',
        title: 'PR 101',
      };

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(openPrStatus);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(mockTicketLinkDelegate.update).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
    });

    it('should set prState to "merged" when PR is merged', async () => {
      const mergedPrStatus: VcsPrStatus = {
        number: 101,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-02-01'),
        mergedBy: 'octocat',
        mergeSha: 'abc123',
        url: 'https://github.com/owner/repo/pull/101',
        title: 'PR 101',
      };

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);
      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'merged',
        prUpdatedAt: new Date(),
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      const updateCall = mockTicketLinkDelegate.update.mock.calls[0][0];
      expect(updateCall.data.prState).toBe('merged');
    });

    it('should map VcsPrStatus.merged=true to prState="merged"', async () => {
      const mergedPrStatus: VcsPrStatus = {
        number: 101,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date(),
        mergedBy: 'user',
        mergeSha: 'sha123',
        url: 'https://github.com/owner/repo/pull/101',
        title: 'Title',
      };

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);
      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'merged',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prState: 'merged',
          }),
        }),
      );
    });
  });

  describe('AC5: Skip on general API error', () => {
    it('should skip PR and continue with remaining PRs when getPullRequestStatus throws general API error', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce(mockTicketLinks);

      // PR 101 throws a general API error (not 404)
      mockVcsProvider.getPullRequestStatus
        .mockRejectedValueOnce(new Error('GitHub API rate limit exceeded'))
        .mockResolvedValueOnce({
          number: 102,
          state: 'open',
          draft: false,
          merged: false,
          mergedAt: null,
          mergedBy: null,
          mergeSha: null,
          url: 'https://github.com/owner/repo/pull/102',
          title: 'PR 102',
        })
        .mockResolvedValueOnce({
          number: 103,
          state: 'closed',
          draft: false,
          merged: true,
          mergedAt: new Date(),
          mergedBy: 'user',
          mergeSha: 'sha103',
          url: 'https://github.com/owner/repo/pull/103',
          title: 'PR 103',
        });

      mockTicketLinkDelegate.update.mockResolvedValue({});

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // PR 101 was skipped, PR 102 and 103 were processed
      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(2);
      expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledTimes(3);
    });

    it('should count skipped PRs in result summary', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new Error('Server error'),
      );

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('should NOT throw when a PR errors - should continue processing remaining PRs', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce(mockTicketLinks);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(new Error('API Error'));

      // The service should NOT throw - it should skip and continue
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();
    });
  });

  describe('AC6: Mark as closed on 404', () => {
    it('should set prState to "closed" when getPullRequestStatus throws NotFoundAppException (404)', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new NotFoundAppException('PR not found'),
      );

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'closed',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: {
          prState: 'closed',
          prUpdatedAt: expect.any(Date),
        },
      });
    });

    it('should count 404 PRs as updated (state changed to closed), not skipped', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new NotFoundAppException('PR not found'),
      );

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'closed',
      });

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // 404 should be counted as updated, not skipped
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });

  describe('AC7: Returns summary of updated and skipped counts', () => {
    it('should return { updated: number, skipped: number }', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([]);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('skipped');
      expect(typeof result.updated).toBe('number');
      expect(typeof result.skipped).toBe('number');
    });

    it('should correctly count multiple PRs with mixed results', async () => {
      // PR 101: updated (state changed)
      // PR 102: skipped (API error)
      // PR 103: updated (state changed)
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce(mockTicketLinks);

      mockVcsProvider.getPullRequestStatus
        .mockResolvedValueOnce({
          number: 101,
          state: 'merged',
          draft: false,
          merged: true,
          mergedAt: new Date(),
          mergedBy: 'user',
          mergeSha: 'sha1',
          url: 'https://github.com/owner/repo/pull/101',
          title: 'PR 101',
        })
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({
          number: 103,
          state: 'merged',
          draft: false,
          merged: true,
          mergedAt: new Date(),
          mergedBy: 'user',
          mergeSha: 'sha3',
          url: 'https://github.com/owner/repo/pull/103',
          title: 'PR 103',
        });

      mockTicketLinkDelegate.update.mockResolvedValue({});

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it('should return zeros when no active PRs exist', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([]);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should process all PRs even if some fail to update in DB', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0], mockTicketLinks[1]]);

      // First PR - fetched state differs, needs update
      mockVcsProvider.getPullRequestStatus
        .mockResolvedValueOnce({
          number: 101,
          state: 'merged',
          draft: false,
          merged: true,
          mergedAt: new Date(),
          mergedBy: 'user',
          mergeSha: 'sha1',
          url: 'https://github.com/owner/repo/pull/101',
          title: 'PR 101',
        })
        .mockResolvedValueOnce({
          number: 102,
          state: 'open',
          draft: false,
          merged: false,
          mergedAt: null,
          mergedBy: null,
          mergeSha: null,
          url: 'https://github.com/owner/repo/pull/102',
          title: 'PR 102',
        });

      // First update succeeds, second update fails
      mockTicketLinkDelegate.update
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({});

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should have processed both PRs (one updated, one skipped due to DB error)
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error handling edge cases', () => {
    it('should handle NotFoundAppException vs general errors differently', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);

      // NotFoundAppException should result in prState='closed', not skipped
      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new NotFoundAppException('PR not found'),
      );

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'closed',
      });

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(1);
      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prState: 'closed',
          }),
        }),
      );
    });

    it('should map fetched state correctly regardless of VCS provider', async () => {
      // When VcsPrStatus.merged is true, prState should be 'merged'
      // When VcsPrStatus.merged is false and state is 'closed', prState should be 'closed'
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinks[0]]);

      const closedPrStatus: VcsPrStatus = {
        number: 101,
        state: 'closed',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/101',
        title: 'PR 101',
      };

      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(closedPrStatus);
      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinks[0],
        prState: 'closed',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      const updateCall = mockTicketLinkDelegate.update.mock.calls[0][0];
      // When merged=false and state='closed', prState should be 'closed'
      expect(updateCall.data.prState).toBe('closed');
    });
  });
});