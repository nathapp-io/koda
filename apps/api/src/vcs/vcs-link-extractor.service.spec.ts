import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import { PrismaVcsRepository } from './prisma-vcs.repository';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import type { VcsConnectionDomain, VcsTicketDomain } from './domain/vcs.domain';

vi.mock('./factory', () => ({
  createVcsProvider: vi.fn(),
}));

vi.mock('../common/utils/encryption.util', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-token'),
}));

vi.mock('./ticket-ref-matcher.util', () => ({
  containsTicketRef: vi.fn(),
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

function makeTicket(overrides?: Partial<VcsTicketDomain>): VcsTicketDomain {
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
  let mockVcsRepo: Mocked<Pick<PrismaVcsRepository, 'upsertTicketLink'>>;
  let mockProvider: {
    getPullRequestStatus: Mock;
    listPrCommits: Mock;
    fetchIssues: Mock;
    fetchIssue: Mock;
    testConnection: Mock;
  };

  const project = { id: 'proj-1', key: 'TEST' };
  const connection = makeConnection();
  const encryptionKey = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockVcsRepo = { upsertTicketLink: vi.fn().mockResolvedValue('link-1') };
    vi.mocked(mockAuditRecorder.record).mockReset();
    vi.mocked(mockAuditRecorder.audited).mockReset().mockImplementation(<T>(fn: () => Promise<T>) => fn());

    mockProvider = {
      getPullRequestStatus: vi.fn().mockResolvedValue({
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
      listPrCommits: vi.fn().mockResolvedValue([]),
      fetchIssues: vi.fn(),
      fetchIssue: vi.fn(),
      testConnection: vi.fn(),
    };

    (createVcsProvider as Mock).mockReturnValue(mockProvider);
    (containsTicketRef as Mock).mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsLinkExtractorService,
        { provide: PrismaVcsRepository, useValue: mockVcsRepo },
        { provide: AuditRecorder, useValue: mockAuditRecorder },
      ],
    }).compile();

    service = module.get<VcsLinkExtractorService>(VcsLinkExtractorService);
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      (containsTicketRef as Mock).mockImplementation((_msg: string, key: string, num: number) => {
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
      (containsTicketRef as Mock).mockReturnValue(true);

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

    it('should not create any commit links when no commits match the ticket reference', async () => {
      const ticket = makeTicket({ number: 42 });
      mockProvider.listPrCommits.mockResolvedValue([
        makeCommit('abc123', 'chore: something unrelated'),
      ]);
      (containsTicketRef as Mock).mockReturnValue(false);

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch', 5);

      // Only the branch link
      expect(mockVcsRepo.upsertTicketLink).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Permissions P2 US-005: a created link is audited under `ticket.link.add`; the update branch of
   * `upsertTicketLink` (which now answers `null`) is bookkeeping and records nothing. The recorder here
   * runs `entriesOf`, so "record was not called" means the extractor described no entry for the result.
   */
  describe('audit entries (Permissions P2 US-005)', () => {
    const ticket = makeTicket({ number: 42 });

    function recordingRecorder() {
      const record = vi.fn(async (_entry: unknown) => undefined);
      const audited = vi.fn(async (
        fn: () => Promise<unknown>,
        entriesOf: (result: unknown) => unknown,
      ): Promise<unknown> => {
        const result = await fn();
        const entries = entriesOf(result);
        for (const entry of Array.isArray(entries) ? entries : [entries]) await record(entry);
        return result;
      });
      return { record, audited };
    }

    const extractorWith = (repo: { upsertTicketLink: Mock }, recorder: object) =>
      new VcsLinkExtractorService(repo as unknown as PrismaVcsRepository, recorder as never);

    it('AC-17: records nothing when upsertTicketLink resolved null (the link already existed)', async () => {
      const repo = { upsertTicketLink: vi.fn().mockResolvedValue(null) };
      const recorder = recordingRecorder();

      await extractorWith(repo, recorder).extractLinksFromPr(
        project, ticket, connection, encryptionKey, 'feature/branch', 5,
      );

      expect(repo.upsertTicketLink).toHaveBeenCalledTimes(1);
      expect(recorder.audited).toHaveBeenCalledTimes(1);
      expect(recorder.record).not.toHaveBeenCalled();
    });

    it('records ticket.link.add for a created branch link, with the project and the ticket ref', async () => {
      const repo = { upsertTicketLink: vi.fn().mockResolvedValue('link-branch') };
      const recorder = recordingRecorder();

      await extractorWith(repo, recorder).extractLinksFromPr(
        project, ticket, connection, encryptionKey, 'feature/branch', 5,
      );

      expect(recorder.record.mock.calls).toEqual([[{
        key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: 'link-branch',
        projectId: 'proj-1', summary: 'on TEST-42',
      }]]);
    });

    it('records one entry per created link and skips a commit link that already existed', async () => {
      const repo = {
        upsertTicketLink: vi.fn().mockResolvedValueOnce('link-branch').mockResolvedValueOnce(null),
      };
      const recorder = recordingRecorder();
      mockProvider.listPrCommits.mockResolvedValue([makeCommit('abc123', 'TEST-42 fix')]);
      (containsTicketRef as Mock).mockReturnValue(true);

      await extractorWith(repo, recorder).extractLinksFromPr(
        project, ticket, connection, encryptionKey, 'feature/branch', 5,
      );

      expect(repo.upsertTicketLink).toHaveBeenCalledTimes(2);
      expect(recorder.record.mock.calls).toEqual([[{
        key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: 'link-branch',
        projectId: 'proj-1', summary: 'on TEST-42',
      }]]);
    });

    it('runs every upsert inside audited, which the injected recorder receives', async () => {
      mockProvider.listPrCommits.mockResolvedValue([makeCommit('abc123', 'TEST-42 fix')]);
      (containsTicketRef as Mock).mockReturnValue(true);

      await service.extractLinksFromPr(project, ticket, connection, encryptionKey, 'feature/branch', 5);

      expect(vi.mocked(mockAuditRecorder.audited)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockAuditRecorder.audited).mock.calls[0][0]).toBeInstanceOf(Function);
      expect(vi.mocked(mockAuditRecorder.audited).mock.calls[0][1]).toBeInstanceOf(Function);
    });
  });
});
