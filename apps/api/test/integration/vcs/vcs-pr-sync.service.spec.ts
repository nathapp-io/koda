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
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';

describe('VcsPrSyncService.syncPrStatus', () => {
  let service: VcsPrSyncService;
  let vcsRepo: jest.Mocked<PrismaVcsRepository>;
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
      url: 'https://github.com/owner/repo/repo/pull/103',
      provider: 'github',
      externalRef: 'owner/repo#103',
      prState: 'open',
      prNumber: 103,
      prUpdatedAt: new Date('2024-01-03'),
      createdAt: new Date(),
    },
  ];

  const mockVcsProvider = {
    getPullRequestStatus: jest.fn(),
    fetchIssues: jest.fn(),
    fetchIssue: jest.fn(),
    testConnection: jest.fn(),
    getDefaultBranch: jest.fn(),
    createPullRequest: jest.fn(),
    listPullRequests: jest.fn(),
  };

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
          provide: PrismaVcsRepository,
          useValue: {
            findExistingTicketByExternalId: jest.fn(),
            createTicketFromIssue: jest.fn(),
            findActiveTicketLinksWithPrs: jest.fn(),
            updateTicketLinkPrState: jest.fn(),
            applyMergedPrTransition: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VcsPrSyncService>(VcsPrSyncService);
    vcsRepo = module.get(PrismaVcsRepository);
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
    it('should query active ticket links via repository for the given project', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([]);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.findActiveTicketLinksWithPrs).toHaveBeenCalledWith(projectId);
    });

    it('should return empty array when no active PRs found', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([]);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('AC3: Calls VCS provider to fetch current PR status', () => {
    it('should call getPullRequestStatus for each matching TicketLink', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce(mockTicketLinks as any);

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
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([]);
      const decryptToken = jest.requireMock('../../../src/common/utils/encryption.util').decryptToken;
      decryptToken.mockReturnValueOnce('decrypted-token');

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(decryptToken).toHaveBeenCalledWith(mockVcsConnection.encryptedToken, 'encryption-key');
    });
  });

  describe('AC4: Updates TicketLink when state differs', () => {
    it('should map open draft PRs to prState="draft"', async () => {
      const draftPrStatus: VcsPrStatus = {
        number: 102,
        state: 'open',
        draft: true,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/102',
        title: 'PR 102',
      };

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[1]] as any);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(draftPrStatus);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.updateTicketLinkPrState).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
    });

    it('should update prState when fetched state differs from stored', async () => {
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

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'merged');
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

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(openPrStatus);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.updateTicketLinkPrState).not.toHaveBeenCalled();
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

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'merged');
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

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith(
        'link-1',
        'merged',
      );
    });
  });

  describe('AC5: Skip on general API error', () => {
    it('should skip PR and continue with remaining PRs when getPullRequestStatus throws general API error', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce(mockTicketLinks as any);

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

      vcsRepo.updateTicketLinkPrState.mockResolvedValue(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // PR 101 was skipped, PR 102 and 103 were processed
      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(2);
      expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledTimes(3);
    });

    it('should count skipped PRs in result summary', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new Error('Server error'),
      );

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('should NOT throw when a PR errors - should continue processing remaining PRs', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce(mockTicketLinks as any);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(new Error('API Error'));

      // The service should NOT throw - it should skip and continue
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();
    });
  });

  describe('AC6: Mark as closed on 404', () => {
    it('should set prState to "closed" when getPullRequestStatus throws NotFoundAppException (404)', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new NotFoundAppException('PR not found'),
      );

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'closed');
    });

    it('should count 404 PRs as updated (state changed to closed), not skipped', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);

      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new NotFoundAppException('PR not found'),
      );

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // 404 should be counted as updated, not skipped
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });

  describe('AC7: Returns summary of updated and skipped counts', () => {
    it('should return { updated: number, skipped: number }', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([]);

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
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce(mockTicketLinks as any);

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

      vcsRepo.updateTicketLinkPrState.mockResolvedValue(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it('should return zeros when no active PRs exist', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([]);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should process all PRs even if some fail to update in DB', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0], mockTicketLinks[1]] as any);

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

      // First update fails DB
      vcsRepo.updateTicketLinkPrState
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should have processed both PRs (one updated, one skipped due to DB error)
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error handling edge cases', () => {
    it('should handle NotFoundAppException vs general errors differently', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);

      // NotFoundAppException should result in prState='closed', not skipped
      mockVcsProvider.getPullRequestStatus.mockRejectedValueOnce(
        new NotFoundAppException('PR not found'),
      );

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(result.updated).toBe(1);
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'closed');
    });

    it('should map fetched state correctly regardless of VCS provider', async () => {
      // When VcsPrStatus.merged is false and state is 'closed', prState should be 'closed'
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinks[0]] as any);

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
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // When merged=false and state='closed', prState should be 'closed'
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'closed');
    });
  });
});
