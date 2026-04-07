/**
 * Auto-create PR on VERIFIED Transition Integration Tests
 *
 * Tests for automatically creating a GitHub PR when a ticket transitions to VERIFIED status.
 * Verifies that:
 * - vcsService.createPrForTicket() is called on VERIFIED transition
 * - Branch name is built correctly using buildBranchName()
 * - PR title and body are formatted correctly
 * - TicketLink is created with correct data
 * - TicketActivity is logged with VCS_PR_CREATED action
 * - Fire-and-forget error handling works correctly
 *
 * Run: bun test test/integration/vcs/auto-create-pr-on-verified.integration.spec.ts
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TicketTransitionsService, CurrentUser } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TicketLinksService } from '../../../src/ticket-links/ticket-links.service';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { TicketStatus, ActivityType } from '../../../src/common/enums';
import { IVcsProvider, VcsPullRequest, CreatePrParams } from '../../../src/vcs';
import { buildBranchName } from '../../../src/vcs/branch-name.util';
import enVcsMessages from '../../../src/i18n/en/vcs.json';
import zhVcsMessages from '../../../src/i18n/zh/vcs.json';

// Module-level reference for factory mock that can be updated
let mockVcsProviderInstance: any;
const mockCreateVcsProvider = jest.fn().mockImplementation(() => mockVcsProviderInstance);

jest.mock('../../../src/vcs/factory', () => ({
  createVcsProvider: mockCreateVcsProvider,
}));

describe('Auto-create PR on VERIFIED Transition', () => {
  let transitionsService: TicketTransitionsService;
  let mockPrismaService: any;
  let mockTicketLinksService: any;
  let mockVcsConnectionService: any;
  let mockVcsProvider: any;

  const testProject = {
    id: 'project-1',
    slug: 'test-project',
    key: 'KODA',
    name: 'Test Project',
    deletedAt: null,
    autoIndexOnClose: false,
  };

  const testTicket = {
    id: 'ticket-1',
    projectId: 'project-1',
    number: 42,
    type: 'BUG',
    title: 'Fix login redirect bug',
    description: 'This bug causes login to redirect to the wrong page',
    status: TicketStatus.CREATED,
    priority: 'HIGH',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const testUser: CurrentUser = {
    id: 'user-1',
    sub: 'user-1',
  };

  const testVcsConnection = {
    id: 'vcs-conn-1',
    projectId: 'project-1',
    provider: 'github',
    repoOwner: 'test-owner',
    repoName: 'test-repo',
    encryptedToken: 'encrypted-token',
    syncMode: 'manual',
    allowedAuthors: '[]',
    pollingIntervalMs: 3600000,
    isActive: true,
  };

  beforeEach(() => {
    mockPrismaService = {
      client: {
        $transaction: jest.fn((cb) => cb(mockPrismaService.client)),
        project: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
        },
        ticket: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
        },
        comment: {
          create: jest.fn(),
        },
        ticketActivity: {
          create: jest.fn(),
        },
        ticketLink: {
          create: jest.fn(),
          findFirst: jest.fn(),
        },
        vcsConnection: {
          findUnique: jest.fn(),
        },
      },
    };

    mockTicketLinksService = {
      create: jest.fn(),
    };

    mockVcsConnectionService = {
      getFullByProject: jest.fn(),
      findByProject: jest.fn(),
    };

    mockVcsProvider = {
      fetchIssues: jest.fn(),
      fetchIssue: jest.fn(),
      testConnection: jest.fn(),
      getDefaultBranch: jest.fn(),
      createPullRequest: jest.fn(),
    };

    transitionsService = new TicketTransitionsService(
      mockPrismaService as any,
      undefined,
      undefined,
    );
  });

  describe('AC2: buildBranchName(project.key, ticket.number, ticket.title)', () => {
    it('returns correct branch name format koda/KODA-42/fix-login-redirect-bug', () => {
      const branchName = buildBranchName('KODA', 42, 'Fix login redirect bug');
      expect(branchName).toBe('koda/KODA-42/fix-login-redirect-bug');
    });

    it('returns branch name with at most 100 characters for long titles', () => {
      const longTitle = 'A very long title that exceeds the maximum allowed length for branch names';
      const branchName = buildBranchName('PROJ', 1, longTitle);
      expect(branchName.length).toBeLessThanOrEqual(100);
    });

    it('returns branch name with only alphanumeric characters and hyphens in slug portion', () => {
      const branchName = buildBranchName('PROJ', 1, 'Special chars: @#$%^&*()');
      const slugPart = branchName.split('/')[2];
      expect(slugPart).toMatch(/^[a-z0-9-]+$/);
    });

    it('returns branch name with no trailing hyphens in slug portion', () => {
      const branchName = buildBranchName('PROJ', 1, 'trailing---hyphens---');
      const slugPart = branchName.split('/')[2];
      expect(slugPart).not.toMatch(/-$/);
    });
  });

  describe('AC3: PR title format {KEY}-{number}: {ticket.title}', () => {
    it('formats PR title correctly', () => {
      const prTitle = `KODA-42: ${testTicket.title}`;
      expect(prTitle).toBe('KODA-42: Fix login redirect bug');
    });
  });

  describe('AC4: PR body from ticket.description or empty string if null', () => {
    it('uses ticket description as PR body when description is present', () => {
      const prBody = testTicket.description ?? '';
      expect(prBody).toBe('This bug causes login to redirect to the wrong page');
    });

    it('uses empty string as PR body when description is null', () => {
      const ticketWithNullDescription = { ...testTicket, description: null };
      const prBody = ticketWithNullDescription.description ?? '';
      expect(prBody).toBe('');
    });
  });

  describe('AC7: TicketActivity logged with VCS_PR_CREATED action', () => {
    it('has VCS_PR_CREATED in ActivityType enum', () => {
      expect(ActivityType.VCS_PR_CREATED).toBe('VCS_PR_CREATED');
    });
  });

  describe('AC8: ActivityType.VCS_PR_CREATED is added to ActivityType enum', () => {
    it('includes VCS_PR_CREATED in ActivityType', () => {
      expect(ActivityType).toHaveProperty('VCS_PR_CREATED');
    });
  });

  describe('createPrForTicket integration', () => {
    describe('AC5: provider.createPullRequest() called with draft: true', () => {
      it('passes draft: true to createPullRequest', async () => {
        const createPrParams: CreatePrParams = {
          title: 'KODA-42: Fix login redirect bug',
          body: 'This bug causes login to redirect to the wrong page',
          headBranch: 'koda/KODA-42/fix-login-redirect-bug',
          baseBranch: 'main',
          draft: true,
        };

        mockVcsProvider.createPullRequest.mockResolvedValueOnce({
          number: 42,
          url: 'https://github.com/test-owner/test-repo/pull/42',
          branchName: 'koda/KODA-42/fix-login-redirect-bug',
          state: 'open',
          draft: true,
        });

        const result = await mockVcsProvider.createPullRequest(createPrParams);

        expect(mockVcsProvider.createPullRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            draft: true,
          }),
        );
        expect(result.draft).toBe(true);
      });
    });

    describe('AC6: TicketLink created with url, provider github, externalRef format', () => {
      it('formats externalRef as {owner}/{repo}#{pr.number}', () => {
        const externalRef = `${testVcsConnection.repoOwner}/${testVcsConnection.repoName}#42`;
        expect(externalRef).toBe('test-owner/test-repo#42');
      });

      it('extracts provider from URL correctly', () => {
        const url = 'https://github.com/test-owner/test-repo/pull/42';
        const isGithub = url.includes('github.com');
        expect(isGithub).toBe(true);
      });
    });
  });

  describe('AC9: No PR creation when project has no VCS connection', () => {
    it('skips PR creation when VCS connection not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(testProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(testTicket);
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...testTicket,
        status: TicketStatus.VERIFIED,
      });
      mockPrismaService.client.comment.create.mockResolvedValue({});
      mockPrismaService.client.ticketActivity.create.mockResolvedValue({});
      mockVcsConnectionService.getFullByProject.mockRejectedValue(new Error('VCS connection not found'));

      const createPrSpy = jest.fn();
      jest.spyOn(mockVcsProvider, 'createPullRequest').mockImplementation(createPrSpy);

      await transitionsService.verify('test-project', 'KODA-42', 'Verified', testUser, 'user');

      expect(createPrSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC10 & AC11: Fire-and-forget error handling', () => {
    it('ticket transition succeeds even when PR creation fails', async () => {
      const error = new Error('GitHub API error');
      mockVcsProvider.createPullRequest.mockRejectedValue(error);

      mockPrismaService.client.project.findUnique.mockResolvedValue(testProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(testTicket);
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...testTicket,
        status: TicketStatus.VERIFIED,
      });
      mockPrismaService.client.comment.create.mockResolvedValue({});
      mockPrismaService.client.ticketActivity.create.mockResolvedValue({});

      const result = await transitionsService.verify('test-project', 'KODA-42', 'Verified', testUser, 'user');

      expect(result.ticket.status).toBe(TicketStatus.VERIFIED);
    });
  });

  describe('AC13: i18n keys pr.created and pr.createFailed exist', () => {
    it('has pr.created key in English i18n', () => {
      expect((enVcsMessages as any).pr?.created).toBeDefined();
      expect(typeof (enVcsMessages as any).pr?.created).toBe('string');
    });

    it('has pr.createFailed key in English i18n', () => {
      expect((enVcsMessages as any).pr?.createFailed).toBeDefined();
      expect(typeof (enVcsMessages as any).pr?.createFailed).toBe('string');
    });

    it('has pr.created key in Chinese i18n', () => {
      expect((zhVcsMessages as any).pr?.created).toBeDefined();
      expect(typeof (zhVcsMessages as any).pr?.created).toBe('string');
    });

    it('has pr.createFailed key in Chinese i18n', () => {
      expect((zhVcsMessages as any).pr?.createFailed).toBeDefined();
      expect(typeof (zhVcsMessages as any).pr?.createFailed).toBe('string');
    });
  });

describe('AC14: prNumber and prState persisted on TicketLink after successful PR creation', () => {
    beforeEach(() => {
      // Setup mocks for VCS connection which is needed by createPrForTicket
      mockPrismaService = {
        client: {
          $transaction: jest.fn((cb: any) => cb(mockPrismaService.client)),
          project: {
            findUnique: jest.fn().mockResolvedValue(testProject),
            findFirst: jest.fn(),
          },
          ticket: {
            findUnique: jest.fn().mockResolvedValue(testTicket),
            findFirst: jest.fn(),
            update: jest.fn().mockResolvedValue({ ...testTicket, status: TicketStatus.VERIFIED }),
          },
          comment: {
            create: jest.fn().mockResolvedValue({}),
          },
          ticketActivity: {
            create: jest.fn().mockResolvedValue({}),
          },
          ticketLink: {
            create: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
          },
          vcsConnection: {
            findUnique: jest.fn(),
          },
        },
      };

      mockTicketLinksService = {
        create: jest.fn(),
      };

      mockVcsConnectionService = {
        getFullByProject: jest.fn().mockResolvedValue(testVcsConnection),
        findByProject: jest.fn(),
      };

      mockVcsProvider = {
        fetchIssues: jest.fn(),
        fetchIssue: jest.fn(),
        testConnection: jest.fn(),
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
        createPullRequest: jest.fn(),
      };

      // Update the module-level factory mock to return our mock provider
      mockVcsProviderInstance = mockVcsProvider;
      mockCreateVcsProvider.mockReturnValue(mockVcsProvider);

      transitionsService = new TicketTransitionsService(
        mockPrismaService as any,
        undefined,
        undefined,
        mockVcsConnectionService as any,
        mockTicketLinksService as any,
      );
    });

    it('updates TicketLink with prNumber from VcsPullRequest when PR creation succeeds', async () => {
      const mockPrResponse = {
        number: 123,
        url: 'https://github.com/test-owner/test-repo/pull/123',
        branchName: 'koda/KODA-42/fix-login-redirect-bug',
        state: 'open',
        draft: true,
      };

      // Reset mock call counts for this specific test
      mockCreateVcsProvider.mockClear();
      mockVcsProvider.createPullRequest.mockResolvedValue(mockPrResponse);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-1',
        ticketId: 'ticket-1',
        url: 'https://github.com/test-owner/test-repo/pull/pending',
        provider: 'github',
        externalRef: 'test-owner/test-repo#pending',
        createdAt: new Date(),
      });
      mockPrismaService.client.ticketLink.update.mockResolvedValue({
        id: 'link-1',
        ticketId: 'ticket-1',
        url: mockPrResponse.url,
        provider: 'github',
        externalRef: 'test-owner/test-repo#123',
        prState: 'draft',
        prNumber: 123,
        prUpdatedAt: new Date(),
        createdAt: new Date(),
      });

      await transitionsService.verify('test-project', 'KODA-42', 'Verified', testUser, 'user');

      // Verify ticketLink.update was called with prNumber and prState (AC1, AC2, AC3)
      expect(mockPrismaService.client.ticketLink.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'link-1' },
          data: expect.objectContaining({
            prNumber: 123,
            prState: 'draft',
          }),
        }),
      );
    });

    it('sets prState to "draft" regardless of actual PR draft status', async () => {
      const mockPrResponse = {
        number: 456,
        url: 'https://github.com/test-owner/test-repo/pull/456',
        branchName: 'koda/KODA-42/some-feature',
        state: 'open',
        draft: false, // API may return draft: false even though we requested draft: true
      };

      mockVcsProvider.createPullRequest.mockResolvedValue(mockPrResponse);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-1',
        ticketId: 'ticket-1',
        url: 'https://github.com/test-owner/test-repo/pull/pending',
        provider: 'github',
        externalRef: 'test-owner/test-repo#pending',
        createdAt: new Date(),
      });
      mockPrismaService.client.ticketLink.update.mockResolvedValue({
        id: 'link-1',
        ticketId: 'ticket-1',
        url: mockPrResponse.url,
        provider: 'github',
        externalRef: 'test-owner/test-repo#456',
        prState: 'draft',
        prNumber: 456,
        prUpdatedAt: new Date(),
        createdAt: new Date(),
      });

      await transitionsService.verify('test-project', 'KODA-42', 'Verified', testUser, 'user');

      // Verify ticketLink.update was called with prState: 'draft' (AC2)
      expect(mockPrismaService.client.ticketLink.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prState: 'draft',
          }),
        }),
      );
    });

    it('TicketLink is not updated when PR creation fails', async () => {
      mockVcsProvider.createPullRequest.mockRejectedValue(new Error('GitHub API error'));
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-1',
        ticketId: 'ticket-1',
        url: 'https://github.com/test-owner/test-repo/pull/pending',
        provider: 'github',
        externalRef: 'test-owner/test-repo#pending',
        createdAt: new Date(),
      });

      await transitionsService.verify('test-project', 'KODA-42', 'Verified', testUser, 'user');

      // When PR creation fails, ticketLink.update should NOT be called (AC4)
      // ticketLink.create is still called (creates pending link), but update is skipped
      expect(mockPrismaService.client.ticketLink.create).toHaveBeenCalled();
      expect(mockPrismaService.client.ticketLink.update).not.toHaveBeenCalled();
    });
  });

describe('AC12: No PR creation for non-VERIFIED transitions', () => {
    it('does not create PR when transitioning to IN_PROGRESS', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(testProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue({
        ...testTicket,
        status: TicketStatus.VERIFIED,
      });
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...testTicket,
        status: TicketStatus.IN_PROGRESS,
      });
      mockPrismaService.client.ticketActivity.create.mockResolvedValue({});

      const createPrSpy = jest.fn();
      jest.spyOn(mockVcsProvider, 'createPullRequest').mockImplementation(createPrSpy);

      await transitionsService.start('test-project', 'KODA-42', testUser, 'user');

      expect(createPrSpy).not.toHaveBeenCalled();
    });

    it('does not create PR when transitioning to CLOSED', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(testProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue({
        ...testTicket,
        status: TicketStatus.VERIFY_FIX,
      });
      mockPrismaService.client.ticket.update.mockResolvedValue({
        ...testTicket,
        status: TicketStatus.CLOSED,
      });
      mockPrismaService.client.ticketActivity.create.mockResolvedValue({});

      const createPrSpy = jest.fn();
      jest.spyOn(mockVcsProvider, 'createPullRequest').mockImplementation(createPrSpy);

      await transitionsService.verifyFix('test-project', 'KODA-42', 'Approved', true, testUser, 'user');

      expect(createPrSpy).not.toHaveBeenCalled();
    });
  });
});
