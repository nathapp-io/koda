/**
 * VcsPrSyncService Auto-Transition Tests (VCS-P3-002-B)
 *
 * Tests for the auto-transition feature when PR is merged:
 * - When prState changes to 'merged' and ticket.status === 'IN_PROGRESS',
 *   transition ticket to 'VERIFY_FIX', create FIX_REPORT comment, log VCS_PR_MERGED activity
 * - When prState changes to 'merged' and ticket.status !== 'IN_PROGRESS',
 *   only update prState without transition
 * - Failure in auto-transition does not prevent prState from being persisted
 * - Respects existing state machine constraints
 *
 * Run: npx jest test/integration/vcs/vcs-pr-sync-auto-transition.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { VcsPrStatus } from '../../../src/vcs/types';
import { TicketStatus, ActivityType } from '../../../src/common/enums';

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

// Import after mocks
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { VCS_REPOSITORY } from '../../../src/vcs/domain/vcs.repository';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';

describe('VcsPrSyncService Auto-Transition on PR Merge (VCS-P3-002-B)', () => {
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

  // Mock TicketLink with associated ticket in IN_PROGRESS status
  const mockTicketLinkInProgress = {
    id: 'link-1',
    ticketId: 'ticket-1',
    url: 'https://github.com/owner/repo/pull/101',
    provider: 'github',
    externalRef: 'owner/repo#101',
    prState: 'open',
    prNumber: 101,
    prUpdatedAt: new Date('2024-01-01'),
    createdAt: new Date(),
    ticket: {
      id: 'ticket-1',
      number: 1,
      projectId,
      status: TicketStatus.IN_PROGRESS,
      externalVcsId: null,
    },
  };

  // Mock TicketLink with associated ticket NOT in IN_PROGRESS status
  const mockTicketLinkVerified = {
    id: 'link-2',
    ticketId: 'ticket-2',
    url: 'https://github.com/owner/repo/pull/102',
    provider: 'github',
    externalRef: 'owner/repo#102',
    prState: 'open',
    prNumber: 102,
    prUpdatedAt: new Date('2024-01-02'),
    createdAt: new Date(),
    ticket: {
      id: 'ticket-2',
      number: 2,
      projectId,
      status: TicketStatus.VERIFIED,
      externalVcsId: null,
    },
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

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    const { createVcsProvider } = require('../../../src/vcs/factory');
    createVcsProvider.mockReturnValue(mockVcsProvider);

    module = await Test.createTestingModule({
      providers: [
        VcsPrSyncService,
        {
          provide: VCS_REPOSITORY,
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
    vcsRepo = module.get(VCS_REPOSITORY);
  });

  afterEach(async () => {
    await module.close();
  });

  // Helper to create merged PR status
  const createMergedPrStatus = (prNumber: number, mergeSha: string, mergedBy: string): VcsPrStatus => ({
    number: prNumber,
    state: 'closed',
    draft: false,
    merged: true,
    mergedAt: new Date('2024-02-01'),
    mergedBy,
    mergeSha,
    url: `https://github.com/owner/repo/pull/${prNumber}`,
    title: `PR ${prNumber}`,
  });

  describe('AC1: When prState changes to merged and ticket.status === IN_PROGRESS, ticket transitions to VERIFY_FIX', () => {
    it('should transition ticket from IN_PROGRESS to VERIFY_FIX when PR is merged', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.applyMergedPrTransition.mockResolvedValueOnce(undefined);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should call applyMergedPrTransition for IN_PROGRESS ticket
      expect(vcsRepo.applyMergedPrTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          externalRef: 'owner/repo#101',
          mergedBy: 'octocat',
          mergeSha: 'abc123',
        }),
      );

      // Should update prState to merged
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'merged');
      expect(result.updated).toBe(1);
    });

    it('should NOT attempt transition when ticket status is VERIFIED (not IN_PROGRESS)', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkVerified] as any);

      const mergedPrStatus = createMergedPrStatus(102, 'def456', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update prState but NOT attempt ticket transition
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-2', 'merged');

      // Should NOT call applyMergedPrTransition
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();

      expect(result.updated).toBe(1);
    });

    it('should NOT attempt transition when ticket status is CREATED', async () => {
      const ticketInCreatedStatus = {
        ...mockTicketLinkInProgress,
        ticket: {
          ...mockTicketLinkInProgress.ticket,
          status: TicketStatus.CREATED,
        },
      };

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([ticketInCreatedStatus] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update prState but NOT transition ticket status
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalled();
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });
  });

  describe('AC2: Auto-transition creates Comment with type FIX_REPORT containing PR URL, merge SHA, and merge author', () => {
    it('should call applyMergedPrTransition with correct PR details', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123def', 'merger-user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.applyMergedPrTransition.mockResolvedValueOnce(undefined);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      expect(vcsRepo.applyMergedPrTransition).toHaveBeenCalledWith({
        ticketId: 'ticket-1',
        externalRef: 'owner/repo#101',
        prUrl: 'https://github.com/owner/repo/pull/101',
        mergedBy: 'merger-user',
        mergeSha: 'abc123def',
      });
    });

    it('should NOT call applyMergedPrTransition when ticket is not IN_PROGRESS', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkVerified] as any);

      const mergedPrStatus = createMergedPrStatus(102, 'def456', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should NOT call applyMergedPrTransition (no comment, no activity)
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });
  });

  describe('AC3: Auto-transition logs TicketActivity with action VCS_PR_MERGED', () => {
    it('should have VCS_PR_MERGED in ActivityType enum', async () => {
      expect(ActivityType.VCS_PR_MERGED).toBe('VCS_PR_MERGED');
    });

    it('should call applyMergedPrTransition which handles VCS_PR_MERGED activity internally', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'sha123', 'merger');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.applyMergedPrTransition.mockResolvedValueOnce(undefined);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // applyMergedPrTransition is the repository method that internally creates
      // the VERIFY_FIX status update, FIX_REPORT comment, and VCS_PR_MERGED activity
      expect(vcsRepo.applyMergedPrTransition).toHaveBeenCalledTimes(1);
    });

    it('should NOT call applyMergedPrTransition when ticket is not IN_PROGRESS', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkVerified] as any);

      const mergedPrStatus = createMergedPrStatus(102, 'sha456', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should NOT call applyMergedPrTransition
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });
  });

  describe('AC4: When prState changes to merged and ticket.status !== IN_PROGRESS, prState is updated but no transition', () => {
    it('should only update prState without transition for VERIFIED ticket', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkVerified] as any);

      const mergedPrStatus = createMergedPrStatus(102, 'xyz789', 'another-user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update TicketLink prState to merged
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-2', 'merged');

      // Should NOT call applyMergedPrTransition
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });

    it('should only update prState without transition for VERIFY_FIX ticket', async () => {
      const ticketInVerifyFix = {
        ...mockTicketLinkInProgress,
        ticket: {
          ...mockTicketLinkInProgress.ticket,
          status: TicketStatus.VERIFY_FIX,
        },
      };

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([ticketInVerifyFix] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'sha789', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update prState
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalled();

      // Should NOT call applyMergedPrTransition
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });
  });

  describe('AC5: Auto-transition respects the existing state machine constraints', () => {
    it('should fail gracefully if applyMergedPrTransition throws ValidationAppException', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'sha', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.applyMergedPrTransition.mockRejectedValueOnce(
        new ValidationAppException({}, 'tickets'),
      );

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      // Should not throw - prState update should still happen
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();

      // prState should still be updated despite transition failure
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'merged');
    });

    it('should handle ticket not found during transition gracefully', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'sha', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      // Simulate applyMergedPrTransition throwing because ticket not found
      vcsRepo.applyMergedPrTransition.mockRejectedValueOnce(new Error('Ticket not found'));
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      // Should not throw - should continue
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();
    });
  });

  describe('AC6: A failure in the auto-transition does not prevent prState from being persisted', () => {
    it('should persist prState=merged even if applyMergedPrTransition fails', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123', 'merger');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.applyMergedPrTransition.mockRejectedValueOnce(
        new Error('Database error during transition'),
      );
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // prState should still be updated
      expect(vcsRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-1', 'merged');
      expect(result.updated).toBe(1);
    });

    it('should continue processing remaining PRs even if one transition fails', async () => {
      const ticketInProgress2 = {
        ...mockTicketLinkInProgress,
        id: 'link-3',
        ticketId: 'ticket-3',
        prNumber: 103,
        ticket: {
          ...mockTicketLinkInProgress.ticket,
          id: 'ticket-3',
          number: 3,
        },
      };

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress, ticketInProgress2] as any);

      // First PR transition fails
      const mergedPr1 = createMergedPrStatus(101, 'sha1', 'user1');
      mockVcsProvider.getPullRequestStatus
        .mockResolvedValueOnce(mergedPr1)
        .mockResolvedValueOnce(createMergedPrStatus(103, 'sha2', 'user2'));

      // First transition fails
      vcsRepo.applyMergedPrTransition
        .mockRejectedValueOnce(new Error('Transition failed'))
        .mockResolvedValueOnce(undefined);

      vcsRepo.updateTicketLinkPrState
        .mockResolvedValueOnce(undefined) // link-1: still updated despite transition failure
        .mockResolvedValueOnce(undefined); // link-3

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should still process the second PR
      expect(result.updated).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle ticket with null ticket relation gracefully', async () => {
      const ticketLinkNoTicket = {
        ...mockTicketLinkInProgress,
        ticket: null,
      };

      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([ticketLinkNoTicket] as any);

      const mergedPrStatus = createMergedPrStatus(101, 'sha', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      // Should not throw - ticket lookup returns null → no transition attempted
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();

      // Should NOT call applyMergedPrTransition when ticket is null
      expect(vcsRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });

    it('should handle missing mergeSha and mergedBy in PR status', async () => {
      vcsRepo.findActiveTicketLinksWithPrs.mockResolvedValueOnce([mockTicketLinkInProgress] as any);

      const mergedPrStatus: VcsPrStatus = {
        number: 101,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-02-01'),
        mergedBy: null,  // missing
        mergeSha: null,  // missing
        url: 'https://github.com/owner/repo/pull/101',
        title: 'PR 101',
      };
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      vcsRepo.applyMergedPrTransition.mockResolvedValueOnce(undefined);
      vcsRepo.updateTicketLinkPrState.mockResolvedValueOnce(undefined);

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should still call applyMergedPrTransition with null values
      expect(vcsRepo.applyMergedPrTransition).toHaveBeenCalledWith({
        ticketId: 'ticket-1',
        externalRef: 'owner/repo#101',
        prUrl: 'https://github.com/owner/repo/pull/101',
        mergedBy: null,
        mergeSha: null,
      });
    });
  });
});
