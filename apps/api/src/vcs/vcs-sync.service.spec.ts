import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { VcsSyncService } from './vcs-sync.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsIssue } from './types';
import type { VcsConnectionDomain } from './domain/vcs.domain';

vi.mock('./factory', () => ({
  createVcsProvider: vi.fn(),
}));

vi.mock('../common/utils/encryption.util', () => ({
  decryptToken: vi.fn().mockReturnValue('decrypted-token'),
}));

import { createVcsProvider } from './factory';

function makeIssue(overrides?: Partial<VcsIssue>): VcsIssue {
  return {
    number: 1,
    title: 'Test issue',
    body: 'Body text',
    authorLogin: 'alice',
    url: 'https://github.com/owner/repo/issues/1',
    labels: [],
    createdAt: new Date(),
    ...overrides,
  };
}

function makeProject(overrides?: Partial<{ id: string; key: string }>): { id: string; key: string } {
  return {
    id: 'proj-1',
    key: 'TEST',
    ...overrides,
  };
}

function makeConnection(overrides?: Partial<VcsConnectionDomain>): VcsConnectionDomain {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'polling',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockRepo(): Mocked<IVcsRepository> {
  return {
    findExistingTicketByExternalId: vi.fn().mockResolvedValue(null),
    createTicketFromIssue: vi.fn().mockResolvedValue({ id: 't-1', number: 1, title: 'Test issue' }),
    findActiveTicketLinksWithPrs: vi.fn().mockResolvedValue([]),
    findTicketLinkForConnectionPr: vi.fn().mockResolvedValue(null),
    updateTicketLinkWithPrState: vi.fn().mockResolvedValue('updated'),
    applyMergedPrTransition: vi.fn().mockResolvedValue(undefined),
    findTicketWithProject: vi.fn().mockResolvedValue(null),
    findProjectById: vi.fn().mockResolvedValue(null),
    findVcsConnectionByProjectId: vi.fn().mockResolvedValue(null),
    findVcsConnectionById: vi.fn().mockResolvedValue(null),
    findVcsConnectionByProjectSlug: vi.fn().mockResolvedValue(null),
    findPollingConnections: vi.fn().mockResolvedValue([]),
    createVcsConnection: vi.fn(),
    updateVcsConnection: vi.fn(),
    updateVcsConnectionLastSynced: vi.fn().mockResolvedValue(undefined),
    deleteVcsConnection: vi.fn().mockResolvedValue(undefined),
    createVcsSyncLog: vi.fn().mockResolvedValue({} as never),
    findPendingOutboxEvents: vi.fn().mockResolvedValue([]),
  } as Mocked<IVcsRepository>;
}

describe('VcsSyncService', () => {
  let service: VcsSyncService;
  let mockRepo: Mocked<IVcsRepository>;

  beforeEach(async () => {
    mockRepo = createMockRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsSyncService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<VcsSyncService>(VcsSyncService);
  });

  describe('syncIssue', () => {
    it('should create a ticket when the issue does not already exist', async () => {
      const project = makeProject();
      const issue = makeIssue();

      mockRepo.findExistingTicketByExternalId.mockResolvedValue(null);
      mockRepo.createTicketFromIssue.mockResolvedValue({ id: 't-1', number: 5, title: issue.title });

      const result = await service.syncIssue(project, issue, 'manual', makeConnection());

      expect(result.action).toBe('created');
      expect(result.ticketId).toBe('t-1');
      expect(result.ticketNumber).toBe(5);
      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledWith(
        project,
        expect.objectContaining({ number: issue.number }),
        'owner/repo#1',
      );
    });

    it('should skip when a ticket with the same external VCS ID already exists', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 42 });

      mockRepo.findExistingTicketByExternalId.mockResolvedValue({ id: 'existing-t' } as any);

      const result = await service.syncIssue(project, issue, 'polling', makeConnection());

      expect(result.action).toBe('skipped');
      expect(mockRepo.createTicketFromIssue).not.toHaveBeenCalled();
    });

    it('should look up the external ID using the string form of the issue number', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 99 });

      await service.syncIssue(project, issue, 'webhook', makeConnection());

      expect(mockRepo.findExistingTicketByExternalId).toHaveBeenCalledWith(project.id, 'owner/repo#99');
    });
  });

  describe('M11: repo-qualified external ids', () => {
    it('dedups and creates with owner/repo#N', async () => {
      const repo = {
        findExistingTicketByExternalId: vi.fn().mockResolvedValue(null),
        createTicketFromIssue: vi.fn().mockResolvedValue({ id: 't1', number: 1, title: 'Issue' }),
      };
      const service = new VcsSyncService(repo as unknown as IVcsRepository);
      const issue = { number: 5, title: 'Issue', body: null, authorLogin: 'a', url: 'u', labels: [], createdAt: new Date() };

      await service.syncIssue({ id: 'p1' }, issue, 'polling', { repoOwner: 'acme', repoName: 'widgets' });

      expect(repo.findExistingTicketByExternalId).toHaveBeenCalledWith('p1', 'acme/widgets#5');
      expect(repo.createTicketFromIssue).toHaveBeenCalledWith({ id: 'p1' }, issue, 'acme/widgets#5');
    });
  });

  describe('filterByAllowedAuthors', () => {
    it('should return all issues when allowedAuthors list is empty', () => {
      const issues = [makeIssue({ authorLogin: 'alice' }), makeIssue({ authorLogin: 'bob' })];
      const result = service.filterByAllowedAuthors(issues, '[]');
      expect(result).toHaveLength(2);
    });

    it('should filter issues to only those whose author is in the allowed list', () => {
      const issues = [
        makeIssue({ authorLogin: 'alice' }),
        makeIssue({ authorLogin: 'bob' }),
        makeIssue({ authorLogin: 'carol' }),
      ];
      const result = service.filterByAllowedAuthors(issues, '["alice","carol"]');
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.authorLogin)).toEqual(['alice', 'carol']);
    });

    it('should return all issues when allowedAuthors JSON is malformed', () => {
      const issues = [makeIssue({ authorLogin: 'alice' })];
      const result = service.filterByAllowedAuthors(issues, 'invalid-json');
      expect(result).toHaveLength(1);
    });

    it('should return empty array when no issues match allowed authors', () => {
      const issues = [makeIssue({ authorLogin: 'bob' })];
      const result = service.filterByAllowedAuthors(issues, '["alice"]');
      expect(result).toHaveLength(0);
    });
  });

  describe('fullSync', () => {
    it('should fetch all issues and create tickets for new ones', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';

      const mockProvider = {
        fetchIssues: vi.fn().mockResolvedValue({
          issues: [
            makeIssue({ number: 1, title: 'Issue 1' }),
            makeIssue({ number: 2, title: 'Issue 2' }),
          ],
          cursor: null,
          capped: false,
        }),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      mockRepo.findExistingTicketByExternalId.mockResolvedValue(null);
      mockRepo.createTicketFromIssue
        .mockResolvedValueOnce({ id: 't-1', number: 1, title: 'Issue 1' })
        .mockResolvedValueOnce({ id: 't-2', number: 2, title: 'Issue 2' });

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result.issuesSynced).toBe(2);
      expect(result.issuesSkipped).toBe(0);
      expect(result.createdTickets).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it('should skip issues that already have a ticket and count them as skipped', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';

      const mockProvider = {
        fetchIssues: vi.fn().mockResolvedValue({ issues: [makeIssue({ number: 1 })], cursor: null, capped: false }),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      mockRepo.findExistingTicketByExternalId.mockResolvedValue({ id: 'existing' } as any);

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result.issuesSynced).toBe(0);
      expect(result.issuesSkipped).toBe(1);
    });

    it('should collect errors for individual issue sync failures without aborting the whole sync', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';

      const mockProvider = {
        fetchIssues: vi.fn().mockResolvedValue({
          issues: [
            makeIssue({ number: 1 }),
            makeIssue({ number: 2 }),
          ],
          cursor: null,
          capped: false,
        }),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      mockRepo.findExistingTicketByExternalId.mockResolvedValue(null);
      mockRepo.createTicketFromIssue
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({ id: 't-2', number: 2, title: 'Issue 2' });

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Issue 1');
      expect(result.issuesSynced).toBe(1);
    });

    it('should surface a top-level error when provider.fetchIssues fails', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';

      const mockProvider = {
        fetchIssues: vi.fn().mockRejectedValue(new Error('Network error')),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Sync failed');
      expect(result.issuesSynced).toBe(0);
    });
  });
});
