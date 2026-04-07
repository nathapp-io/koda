/**
 * VcsLinkExtractorService Integration Tests
 *
 * Tests for the VcsLinkExtractorService that extracts links from PRs:
 * - Creates TicketLink with linkType='branch' for PR head branch URL
 * - Creates TicketLink entries with linkType='commit' for commits matching ticket ref
 * - Upserts on @@unique([ticketId, url]) to avoid duplicates
 * - Skips commits without ticket ref
 * - Integration with createPrForTicket and syncPrStatus
 * - Graceful handling of GitHub API failures during commit listing
 *
 * Run: npx jest test/integration/vcs/vcs-link-extractor.service.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Logger } from '@nestjs/common';
import { VcsCommit, VcsPrStatus } from '../../../src/vcs/types';
import { containsTicketRef } from '../../../src/vcs/ticket-ref-matcher.util';

// Mock the VCS factory
const mockCreateVcsProvider = jest.fn();
jest.mock('../../../src/vcs/factory', () => ({
  createVcsProvider: mockCreateVcsProvider,
}));

// Mock decryptToken utility
jest.mock('../../../src/common/utils/encryption.util', () => ({
  decryptToken: jest.fn((token: string) => 'decrypted-token'),
}));

// Import after mocks are set up
import { VcsLinkExtractorService } from '../../../src/vcs/vcs-link-extractor.service';

// Test data
const mockProject = {
  id: 'project-1',
  key: 'KODA',
  name: 'Koda Project',
  slug: 'koda',
  deletedAt: null,
};

const mockTicket = {
  id: 'ticket-1',
  projectId: 'project-1',
  number: 42,
  type: 'BUG' as const,
  title: 'Test ticket',
  description: 'Test description',
  status: 'IN_PROGRESS' as const,
  priority: 'HIGH' as const,
  assignedToUserId: null,
  assignedToAgentId: null,
  createdByUserId: 'user-1',
  externalVcsId: null,
  externalVcsUrl: null,
  vcsSyncedAt: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockVcsConnection = {
  id: 'vcs-conn-1',
  projectId: 'project-1',
  provider: 'github',
  repoOwner: 'test-owner',
  repoName: 'test-repo',
  encryptedToken: 'encrypted-token',
  syncMode: 'manual' as const,
  allowedAuthors: '[]',
  pollingIntervalMs: 60000,
  webhookSecret: null,
  lastSyncedAt: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockBranchName = 'koda/KODA-42/test-branch';

const mockPrStatus: VcsPrStatus = {
  number: 123,
  state: 'open',
  draft: false,
  merged: false,
  mergedAt: null,
  mergedBy: null,
  mergeSha: null,
  url: 'https://github.com/test-owner/test-repo/pull/123',
  title: 'KODA-42: Test PR',
};

const mockCommits: VcsCommit[] = [
  {
    sha: 'abc123',
    message: 'KODA-42: Add new feature',
    authorLogin: 'testuser',
    url: 'https://github.com/test-owner/test-repo/commit/abc123',
    date: new Date('2024-01-01'),
  },
  {
    sha: 'def456',
    message: 'KODA-42: Fix bug in auth',
    authorLogin: 'testuser',
    url: 'https://github.com/test-owner/test-repo/commit/def456',
    date: new Date('2024-01-02'),
  },
  {
    sha: 'ghi789',
    message: 'KODA-43: Unrelated commit', // Different ticket number - should be skipped
    authorLogin: 'testuser',
    url: 'https://github.com/test-owner/test-repo/commit/ghi789',
    date: new Date('2024-01-03'),
  },
  {
    sha: 'jkl012',
    message: 'No ticket ref here',
    authorLogin: 'testuser',
    url: 'https://github.com/test-owner/test-repo/commit/jkl012',
    date: new Date('2024-01-04'),
  },
];

describe('VcsLinkExtractorService', () => {
  let service: VcsLinkExtractorService;
  let mockPrismaService: any;
  let mockVcsProvider: any;

  beforeEach(async () => {
    mockVcsProvider = {
      fetchIssues: jest.fn(),
      fetchIssue: jest.fn(),
      testConnection: jest.fn(),
      getDefaultBranch: jest.fn(),
      createPullRequest: jest.fn(),
      getPullRequestStatus: jest.fn(),
      listPullRequests: jest.fn(),
      listPrCommits: jest.fn(),
    };

    mockCreateVcsProvider.mockReturnValue(mockVcsProvider);

    mockPrismaService = {
      client: {
        ticketLink: {
          create: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        project: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
        },
        ticket: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
        },
        $transaction: jest.fn((cb: any) => cb(mockPrismaService.client)),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsLinkExtractorService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        Logger,
      ],
    }).compile();

    service = module.get<VcsLinkExtractorService>(VcsLinkExtractorService);
  });

  afterEach(async () => {
    jest.clearAllMocks();
  });

  describe('AC1: extractLinksFromPr creates branch link', () => {
    it('creates TicketLink with linkType=branch for PR head branch URL', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        url: `https://github.com/${mockVcsConnection.repoOwner}/${mockVcsConnection.repoName}/tree/${mockBranchName}`,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      expect(mockPrismaService.client.ticketLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: mockTicket.id,
            url: `https://github.com/${mockVcsConnection.repoOwner}/${mockVcsConnection.repoName}/tree/${mockBranchName}`,
            provider: 'github',
            linkType: 'branch',
          }),
        }),
      );
    });

    it('branch URL format is https://github.com/{owner}/{repo}/tree/{branchName}', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        url: `https://github.com/test-owner/test-repo/tree/koda/KODA-42/test-branch`,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      const createCall = mockPrismaService.client.ticketLink.create.mock.calls[0][0];
      const url = createCall.data.url;
      expect(url).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\/tree\/.+$/);
      expect(url).toContain(`/tree/${mockBranchName}`);
    });
  });

  describe('AC2: extractLinksFromPr creates commit links for matching commits', () => {
    it('creates TicketLink with linkType=commit for each commit containing ticket ref', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue(mockCommits);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-commit-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'commit',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      // Should be called for branch link + 2 matching commits (KODA-42 appears twice)
      expect(mockPrismaService.client.ticketLink.create).toHaveBeenCalledTimes(3);

      // Verify commit links have linkType=commit
      const commitCalls = mockPrismaService.client.ticketLink.create.mock.calls.filter(
        (call: any) => call[0].data.linkType === 'commit',
      );
      expect(commitCalls.length).toBe(2);
    });

    it('uses containsTicketRef for case-insensitive matching', async () => {
      // Verify containsTicketRef works case-insensitively
      expect(containsTicketRef('KODA-42: fix', 'KODA', 42)).toBe(true);
      expect(containsTicketRef('koda-42: fix', 'KODA', 42)).toBe(true);
      expect(containsTicketRef('KoDa-42: fix', 'KODA', 42)).toBe(true);
    });

    it('matches ticket ref with correct number but different case key', async () => {
      expect(containsTicketRef('koda-42: fix bug', 'KODA', 42)).toBe(true);
    });

    it('does not match different ticket number', async () => {
      expect(containsTicketRef('KODA-43: fix bug', 'KODA', 42)).toBe(false);
    });

    it('commit URL is taken from VcsCommit.url', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([mockCommits[0]]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-commit-1',
        ticketId: mockTicket.id,
        url: mockCommits[0].url,
        provider: 'github',
        linkType: 'commit',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      const commitCall = mockPrismaService.client.ticketLink.create.mock.calls.find(
        (call: any) => call[0].data.linkType === 'commit',
      );
      expect(commitCall[0].data.url).toBe(mockCommits[0].url);
    });
  });

  describe('AC3: extractLinksFromPr does not create duplicate links - upserts on @@unique([ticketId, url])', () => {
    it('uses upsert to avoid duplicate links', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([mockCommits[0]]);

      // Existing link found - should use upsert
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue({
        id: 'existing-link',
        ticketId: mockTicket.id,
        url: `https://github.com/${mockVcsConnection.repoOwner}/${mockVcsConnection.repoName}/tree/${mockBranchName}`,
        provider: 'github',
        linkType: 'branch',
      });

      mockPrismaService.client.ticketLink.upsert.mockResolvedValue({
        id: 'existing-link',
        ticketId: mockTicket.id,
        url: `https://github.com/${mockVcsConnection.repoOwner}/${mockVcsConnection.repoName}/tree/${mockBranchName}`,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      // findFirst should be called to check for existing
      expect(mockPrismaService.client.ticketLink.findFirst).toHaveBeenCalled();
      // If findFirst returns something, upsert should be used
      expect(mockPrismaService.client.ticketLink.upsert).toHaveBeenCalled();
    });

    it('creates new link when none exists', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'new-link',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      expect(mockPrismaService.client.ticketLink.create).toHaveBeenCalled();
    });
  });

  describe('AC4: extractLinksFromPr skips commits without ticket ref', () => {
    it('does not create commit link for commit without ticket ref', async () => {
      const commitsWithoutRef: VcsCommit[] = [
        {
          sha: 'jkl012',
          message: 'No ticket ref here',
          authorLogin: 'testuser',
          url: 'https://github.com/test-owner/test-repo/commit/jkl012',
          date: new Date('2024-01-04'),
        },
      ];

      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue(commitsWithoutRef);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      // Only branch link should be created, no commit links
      const commitCalls = mockPrismaService.client.ticketLink.create.mock.calls.filter(
        (call: any) => call[0].data.linkType === 'commit',
      );
      expect(commitCalls.length).toBe(0);
    });

    it('skips commits with different ticket number', async () => {
      const commitsWithDifferentTicket: VcsCommit[] = [
        {
          sha: 'ghi789',
          message: 'KODA-43: Unrelated commit', // Different ticket number
          authorLogin: 'testuser',
          url: 'https://github.com/test-owner/test-repo/commit/ghi789',
          date: new Date('2024-01-03'),
        },
      ];

      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue(commitsWithDifferentTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      // Only branch link should be created
      const commitCalls = mockPrismaService.client.ticketLink.create.mock.calls.filter(
        (call: any) => call[0].data.linkType === 'commit',
      );
      expect(commitCalls.length).toBe(0);
    });
  });

  describe('AC7: When GitHub API fails during commit listing, branch link is still created and error logged as warning', () => {
    it('creates branch link even when listPrCommits throws', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockRejectedValue(new Error('GitHub API rate limit exceeded'));
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        url: `https://github.com/${mockVcsConnection.repoOwner}/${mockVcsConnection.repoName}/tree/${mockBranchName}`,
        provider: 'github',
        linkType: 'branch',
      });

      // Should not throw
      await expect(
        service.extractLinksFromPr(
          mockProject,
          mockTicket as any,
          mockVcsConnection,
          'encryption-key',
          mockBranchName,
        ),
      ).resolves.not.toThrow();

      // Branch link should still be created
      const branchCalls = mockPrismaService.client.ticketLink.create.mock.calls.filter(
        (call: any) => call[0].data.linkType === 'branch',
      );
      expect(branchCalls.length).toBe(1);
    });

    it('logs warning when commit listing fails', async () => {
      const loggerWarnSpy = jest.spyOn(service['logger'], 'warn');

      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockRejectedValue(new Error('GitHub API error'));
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to list PR commits'),
      );
    });
  });

  describe('extractLinksFromPr signature and behavior', () => {
    it('accepts project with id and key', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledWith(mockPrStatus.number);
    });

    it('decrypts token before creating provider', async () => {
      const decryptToken = require('../../../src/common/utils/encryption.util').decryptToken;

      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      expect(decryptToken).toHaveBeenCalledWith(mockVcsConnection.encryptedToken, 'encryption-key');
    });

    it('calls provider.listPrCommits with the PR number', async () => {
      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue([]);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-branch-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'branch',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      expect(mockVcsProvider.listPrCommits).toHaveBeenCalledWith(mockPrStatus.number);
    });
  });

  describe('link deduplication by ticketId and url', () => {
    it('does not create duplicate commit links for same SHA', async () => {
      const duplicateCommits: VcsCommit[] = [
        {
          sha: 'abc123',
          message: 'KODA-42: First commit message',
          authorLogin: 'testuser',
          url: 'https://github.com/test-owner/test-repo/commit/abc123',
          date: new Date('2024-01-01'),
        },
        {
          sha: 'abc123', // Same SHA - deduplicated
          message: 'KODA-42: Updated commit message',
          authorLogin: 'testuser',
          url: 'https://github.com/test-owner/test-repo/commit/abc123',
          date: new Date('2024-01-02'),
        },
      ];

      mockVcsProvider.getPullRequestStatus.mockResolvedValue(mockPrStatus);
      mockVcsProvider.listPrCommits.mockResolvedValue(duplicateCommits);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue({
        id: 'link-commit-1',
        ticketId: mockTicket.id,
        provider: 'github',
        linkType: 'commit',
      });

      await service.extractLinksFromPr(
        mockProject,
        mockTicket as any,
        mockVcsConnection,
        'encryption-key',
        mockBranchName,
      );

      // Should only create one commit link (deduplicated by URL)
      const commitCalls = mockPrismaService.client.ticketLink.create.mock.calls.filter(
        (call: any) => call[0].data.linkType === 'commit',
      );
      expect(commitCalls.length).toBe(1);
    });
  });
});

describe('containsTicketRef integration with VcsCommit messages', () => {
  it('correctly identifies matching ticket refs in commit messages', () => {
    const matchingRefs = [
      'KODA-42: Add feature',
      'koda-42 fix bug',
      '[KODA-42] Refactor',
      'KODA-42 WIP',
    ];

    for (const msg of matchingRefs) {
      expect(containsTicketRef(msg, 'KODA', 42)).toBe(true);
    }
  });

  it('correctly rejects non-matching ticket refs in commit messages', () => {
    const nonMatchingRefs = [
      'KODA-43: Wrong number',
      'KODA-1: Different number',
      'PROJECT-42: Different key',
      'KODA: No number',
      '42: Just a number',
      'prefixKODA-42suffix: Not word boundary',
    ];

    for (const msg of nonMatchingRefs) {
      expect(containsTicketRef(msg, 'KODA', 42)).toBe(false);
    }
  });
});
