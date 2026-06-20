import { Test, TestingModule } from '@nestjs/testing';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import { PrismaVcsRepository } from './prisma-vcs.repository';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import type { VcsTicketRef } from './vcs-link-extractor.service';

jest.mock('./factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../common/utils/encryption.util', () => ({
  decryptToken: jest.fn().mockReturnValue('plain-token'),
}));

jest.mock('./ticket-ref-matcher.util', () => ({
  containsTicketRef: jest.fn(),
}));

import { createVcsProvider } from './factory';
import { containsTicketRef } from './ticket-ref-matcher.util';

function makeConnection(overrides?: Partial<VcsConnectionDomain>): VcsConnectionDomain {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'webhook',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: 'secret',
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTicket(overrides?: Partial<VcsTicketRef>): VcsTicketRef {
  return {
    id: 'ticket-1',
    number: 42,
    externalVcsId: 'owner/repo#5',
    ...overrides,
  };
}

function makeCommit(sha: string, message: string) {
  return {
    sha,
    message,
    authorLogin: 'dev',
    url: `https://github.com/owner/repo/commit/${sha}`,
    date: new Date(),
  };
}

describe('VcsLinkExtractorService', () => {
  let service: VcsLinkExtractorService;
  let mockVcsRepo: jest.Mocked<Pick<PrismaVcsRepository, 'upsertTicketLink'>>;
  let mockProvider: {
    getPullRequestStatus: jest.Mock;
    listPrCommits: jest.Mock;
    fetchIssues: jest.Mock;
    fetchIssue: jest.Mock;
    testConnection: jest.Mock;
  };

  const project = { id: 'proj-1', key: 'TEST' };
  const connection = makeConnection();
  const encryptionKey = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockVcsRepo = { upsertTicketLink: jest.fn().mockResolvedValue(undefined) };

    mockProvider = {
      getPullRequestStatus: jest.fn().mockResolvedValue({
        number: 5,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/5',
        title: 'PR title',
        branchName: 'feature/branch',
      }),
      listPrCommits: jest.fn().mockResolvedValue([]),
      fetchIssues: jest.fn(),
      fetchIssue: jest.fn(),
      testConnection: jest.fn(),
    };

    (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);
    (containsTicketRef as jest.Mock).mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsLinkExtractorService,
        { provide: PrismaVcsRepository, useValue: mockVcsRepo },
      ],
    }).compile();

    service = module.get<VcsLinkExtractorService>(VcsLinkExtractorService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('extractLinksFromPr', () => {
    it('should upsert a branch link for the PR head branch', async () => {
      const ticket = makeTicket();

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/my-branch', 5);

      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledWith(
        ticket.id,
        'https://github.com/owner/repo/tree/feature/my-branch',
        'github',
        'branch',
        'feature/my-branch',
        undefined,
      );
    });

    it('should create commit links for commits that contain the ticket reference', async () => {
      const ticket = makeTicket({ number: 42 });
      const matchingCommit = makeCommit('abc123', 'TEST-42 fix the issue');
      const nonMatchingCommit = makeCommit('def456', 'chore: update deps');

      mockProvider.listPrCommits.mockResolvedValue([matchingCommit, nonMatchingCommit]);
      (containsTicketRef as jest.Mock).mockImplementation((_msg: string, key: string, num: number) => {
        return key === 'TEST' && num === 42 && _msg.includes('TEST-42');
      });

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch', 5);

      // Branch link + 1 commit link
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledTimes(2);
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledWith(
        ticket.id,
        matchingCommit.url,
        'github',
        'commit',
        matchingCommit.message,
        matchingCommit.date,
      );
    });

    it('should deduplicate commit links by URL', async () => {
      const ticket = makeTicket({ number: 42 });
      const commit = makeCommit('abc123', 'TEST-42 fix');
      // Duplicate with same URL
      const duplicateCommit = { ...commit };

      mockProvider.listPrCommits.mockResolvedValue([commit, duplicateCommit]);
      (containsTicketRef as jest.Mock).mockReturnValue(true);

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch', 5);

      // Branch link + 1 unique commit link (not 2)
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledTimes(2);
    });

    it('should still create the branch link and return early when listPrCommits fails', async () => {
      const ticket = makeTicket();
      mockProvider.listPrCommits.mockRejectedValue(new Error('API rate limit'));

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch', 5);

      // Only the branch link should be created
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledTimes(1);
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledWith(
        ticket.id,
        expect.stringContaining('/tree/feature/branch'),
        'github',
        'branch',
        'feature/branch',
        undefined,
      );
    });

    it('should resolve prNumber from ticket.externalVcsId when prNumber argument is not provided', async () => {
      const ticket = makeTicket({ externalVcsId: 'owner/repo#10' });

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch');

      expect(mockProvider.getPullRequestStatus).toHaveBeenCalledWith(10);
    });

    it('should not create any commit links when no commits match the ticket reference', async () => {
      const ticket = makeTicket({ number: 42 });
      mockProvider.listPrCommits.mockResolvedValue([
        makeCommit('abc123', 'chore: something unrelated'),
      ]);
      (containsTicketRef as jest.Mock).mockReturnValue(false);

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch', 5);

      // Only the branch link
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledTimes(1);
    });
  });
});
