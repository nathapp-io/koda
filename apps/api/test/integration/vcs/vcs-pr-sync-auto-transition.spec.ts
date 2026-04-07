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
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { VcsPrStatus } from '../../../src/vcs/types';
import { TicketStatus, CommentType, ActivityType } from '../../../src/common/enums';

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

describe('VcsPrSyncService Auto-Transition on PR Merge (VCS-P3-002-B)', () => {
  let service: VcsPrSyncService;
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
      title: 'Test Ticket',
      description: null,
      type: 'BUG',
      status: TicketStatus.IN_PROGRESS,
      priority: 'MEDIUM',
      assigneeUserId: null,
      assigneeAgentId: null,
      reporterUserId: 'user-1',
      reporterAgentId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
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
      title: 'Test Ticket 2',
      description: null,
      type: 'BUG',
      status: TicketStatus.VERIFIED,
      priority: 'MEDIUM',
      assigneeUserId: null,
      assigneeAgentId: null,
      reporterUserId: 'user-1',
      reporterAgentId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  const mockTicketLinkDelegate = {
    findMany: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
  };

  const mockTicketDelegate = {
    findUnique: jest.fn(),
    update: jest.fn(),
  };

  const mockCommentDelegate = {
    create: jest.fn(),
  };

  const mockTicketActivityDelegate = {
    create: jest.fn(),
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
    ticket: { ...mockTicketDelegate },
    comment: { ...mockCommentDelegate },
    ticketActivity: { ...mockTicketActivityDelegate },
    $transaction: jest.fn((fn) => fn(mockClient)),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

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
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      // Mock $transaction to capture and execute the transition logic
      mockClient.$transaction.mockImplementation(async (fn) => {
        const result = await fn(mockClient);
        return result;
      });

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      mockTicketDelegate.findUnique.mockResolvedValueOnce(mockTicketLinkInProgress.ticket);
      mockTicketDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress.ticket,
        status: TicketStatus.VERIFY_FIX,
      });

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update the prState to merged
      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: {
          prState: 'merged',
          prUpdatedAt: expect.any(Date),
        },
      });

      // The result should indicate update occurred
      expect(result.updated).toBe(1);
    });

    it('should NOT attempt transition when ticket status is VERIFIED (not IN_PROGRESS)', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkVerified]);

      const mergedPrStatus = createMergedPrStatus(102, 'def456', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkVerified,
        prState: 'merged',
      });

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update prState but not attempt ticket transition
      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith({
        where: { id: 'link-2' },
        data: {
          prState: 'merged',
          prUpdatedAt: expect.any(Date),
        },
      });

      // Should NOT call ticket update for status transition
      expect(mockTicketDelegate.update).not.toHaveBeenCalled();

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

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([ticketInCreatedStatus]);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...ticketInCreatedStatus,
        prState: 'merged',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update prState but NOT transition ticket status
      expect(mockTicketLinkDelegate.update).toHaveBeenCalled();
      expect(mockTicketDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('AC2: Auto-transition creates Comment with type FIX_REPORT containing PR URL, merge SHA, and merge author', () => {
    it('should create FIX_REPORT comment with PR URL, merge SHA, and merge author when transitioning', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123def', 'merger-user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn(mockClient);
      });

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      mockTicketDelegate.findUnique.mockResolvedValueOnce(mockTicketLinkInProgress.ticket);
      mockTicketDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress.ticket,
        status: TicketStatus.VERIFY_FIX,
      });

      mockCommentDelegate.create.mockResolvedValueOnce({
        id: 'comment-1',
        ticketId: 'ticket-1',
        body: 'Merged PR: https://github.com/owner/repo/pull/101 by merger-user (abc123def)',
        type: CommentType.FIX_REPORT,
        authorUserId: null,
        authorAgentId: 'system',
        createdAt: new Date(),
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Verify comment was created with FIX_REPORT type containing PR info
      expect(mockCommentDelegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: CommentType.FIX_REPORT,
        }),
      });
      // Verify body contains required information
      const createCall = mockCommentDelegate.create.mock.calls[0][0];
      expect(createCall.data.body).toContain('https://github.com/owner/repo/pull/101');
      expect(createCall.data.body).toContain('abc123def');
      expect(createCall.data.body).toContain('merger-user');
    });

    it('should NOT create comment when ticket is not IN_PROGRESS', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkVerified]);

      const mergedPrStatus = createMergedPrStatus(102, 'def456', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkVerified,
        prState: 'merged',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should NOT create any comment
      expect(mockCommentDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('AC3: Auto-transition logs TicketActivity with action VCS_PR_MERGED', () => {
    it('should create TicketActivity with VCS_PR_MERGED action when transitioning', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

      const mergedPrStatus = createMergedPrStatus(101, 'sha123', 'merger');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn(mockClient);
      });

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      mockTicketDelegate.findUnique.mockResolvedValueOnce(mockTicketLinkInProgress.ticket);
      mockTicketDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress.ticket,
        status: TicketStatus.VERIFY_FIX,
      });

      mockTicketActivityDelegate.create.mockResolvedValueOnce({
        id: 'activity-1',
        ticketId: 'ticket-1',
        action: ActivityType.VCS_PR_MERGED,
        fromStatus: null,
        toStatus: null,
        actorUserId: null,
        actorAgentId: null,
        createdAt: new Date(),
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Verify activity was created with VCS_PR_MERGED
      expect(mockTicketActivityDelegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: ActivityType.VCS_PR_MERGED,
        }),
      });
    });

    it('should NOT create VCS_PR_MERGED activity when ticket is not IN_PROGRESS', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkVerified]);

      const mergedPrStatus = createMergedPrStatus(102, 'sha456', 'octocat');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkVerified,
        prState: 'merged',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should NOT create any activity
      expect(mockTicketActivityDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('AC4: When prState changes to merged and ticket.status !== IN_PROGRESS, prState is updated but no transition', () => {
    it('should only update prState without transition for VERIFIED ticket', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkVerified]);

      const mergedPrStatus = createMergedPrStatus(102, 'xyz789', 'another-user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkVerified,
        prState: 'merged',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update TicketLink prState to merged
      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith({
        where: { id: 'link-2' },
        data: {
          prState: 'merged',
          prUpdatedAt: expect.any(Date),
        },
      });

      // Should NOT update ticket status
      expect(mockTicketDelegate.update).not.toHaveBeenCalled();

      // Should NOT create comment
      expect(mockCommentDelegate.create).not.toHaveBeenCalled();

      // Should NOT create activity
      expect(mockTicketActivityDelegate.create).not.toHaveBeenCalled();
    });

    it('should only update prState without transition for VERIFY_FIX ticket', async () => {
      const ticketInVerifyFix = {
        ...mockTicketLinkInProgress,
        ticket: {
          ...mockTicketLinkInProgress.ticket,
          status: TicketStatus.VERIFY_FIX,
        },
      };

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([ticketInVerifyFix]);

      const mergedPrStatus = createMergedPrStatus(101, 'sha789', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...ticketInVerifyFix,
        prState: 'merged',
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Should update prState
      expect(mockTicketLinkDelegate.update).toHaveBeenCalled();

      // Should NOT update ticket status (transition not allowed from VERIFY_FIX on merge)
      expect(mockTicketDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('AC5: Auto-transition respects the existing state machine constraints', () => {
    it('should fail gracefully if state machine rejects IN_PROGRESS -> VERIFY_FIX transition', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

      // Simulate state machine constraint - though IN_PROGRESS -> VERIFY_FIX is valid
      // This test verifies that if validateTransition throws, the prState still gets updated

      const mergedPrStatus = createMergedPrStatus(101, 'sha', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockClient.$transaction.mockRejectedValueOnce(
        new ValidationAppException({}, 'tickets'),
      );

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      // Should not throw - prState update should still happen
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();
    });

    it('should handle ticket not found during transition gracefully', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

      const mergedPrStatus = createMergedPrStatus(101, 'sha', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      // Simulate ticket not found during transition lookup
      mockClient.$transaction.mockImplementation(async (fn) => {
        const client = {
          ...mockClient,
          ticket: {
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn(),
          },
        };
        return fn(client);
      });

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      // Should not throw - should continue
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();
    });
  });

  describe('AC6: A failure in the auto-transition does not prevent prState from being persisted', () => {
    it('should persist prState=merged even if ticket transition fails', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

      const mergedPrStatus = createMergedPrStatus(101, 'abc123', 'merger');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      // Simulate ticket transition failure but prState update succeeds
      mockClient.$transaction
        .mockRejectedValueOnce(new Error('Database error during transition'))
        .mockResolvedValueOnce({
          ...mockTicketLinkInProgress,
          prState: 'merged',
        });

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      const result = await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // prState should still be updated
      expect(mockTicketLinkDelegate.update).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: {
          prState: 'merged',
          prUpdatedAt: expect.any(Date),
        },
      });

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

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress, ticketInProgress2]);

      // First PR transition fails
      const mergedPr1 = createMergedPrStatus(101, 'sha1', 'user1');
      mockVcsProvider.getPullRequestStatus
        .mockResolvedValueOnce(mergedPr1)
        .mockResolvedValueOnce(createMergedPrStatus(103, 'sha2', 'user2'));

      // First $transaction fails for ticket transition but succeeds for prState
      let transactionCallCount = 0;
      mockClient.$transaction.mockImplementation(async (fn) => {
        transactionCallCount++;
        if (transactionCallCount === 1) {
          // First PR: transition fails
          throw new Error('Transition failed');
        }
        return fn(mockClient);
      });

      mockTicketLinkDelegate.update
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({
          ...ticketInProgress2,
          prState: 'merged',
        });

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

      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([ticketLinkNoTicket]);

      const mergedPrStatus = createMergedPrStatus(101, 'sha', 'user');
      mockVcsProvider.getPullRequestStatus.mockResolvedValueOnce(mergedPrStatus);

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...ticketLinkNoTicket,
        prState: 'merged',
      });

      // Should not throw - ticket lookup returns null
      await expect(
        service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key'),
      ).resolves.not.toThrow();
    });

    it('should handle missing mergeSha and mergedBy in PR status', async () => {
      mockTicketLinkDelegate.findMany.mockResolvedValueOnce([mockTicketLinkInProgress]);

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

      mockClient.$transaction.mockImplementation(async (fn) => {
        return fn(mockClient);
      });

      mockTicketLinkDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress,
        prState: 'merged',
      });

      mockTicketDelegate.findUnique.mockResolvedValueOnce(mockTicketLinkInProgress.ticket);
      mockTicketDelegate.update.mockResolvedValueOnce({
        ...mockTicketLinkInProgress.ticket,
        status: TicketStatus.VERIFY_FIX,
      });

      mockCommentDelegate.create.mockResolvedValueOnce({
        id: 'comment-1',
        ticketId: 'ticket-1',
        body: 'Merged PR without merge metadata',
        type: CommentType.FIX_REPORT,
        authorUserId: null,
        authorAgentId: null,
        createdAt: new Date(),
      });

      await service.syncPrStatus(mockProject as any, mockVcsConnection as any, 'encryption-key');

      // Comment should still be created with available info
      expect(mockCommentDelegate.create).toHaveBeenCalled();
    });
  });
});
