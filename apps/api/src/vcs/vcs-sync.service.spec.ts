import { Test, TestingModule } from '@nestjs/testing';
import { VcsSyncService } from './vcs-sync.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsIssue } from './types';
import type { VcsConnectionDomain } from './domain/vcs.domain';

jest.mock('./factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../common/utils/encryption.util', () => ({
  decryptToken: jest.fn().mockReturnValue('decrypted-token'),
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

function createMockRepo(): jest.Mocked<IVcsRepository> {
  return {
    findExistingTicketByExternalId: jest.fn().mockResolvedValue(null),
    createTicketFromIssue: jest.fn().mockResolvedValue({ id: 't-1', number: 1, title: 'Test issue' }),
    findActiveTicketLinksWithPrs: jest.fn().mockResolvedValue([]),
    findTicketLinkByPrNumber: jest.fn().mockResolvedValue(null),
    updateTicketLinkPrState: jest.fn().mockResolvedValue(undefined),
    updateTicketLinkWithPrState: jest.fn().mockResolvedValue(undefined),
    applyMergedPrTransition: jest.fn().mockResolvedValue(undefined),
    findTicketWithProject: jest.fn().mockResolvedValue(null),
    findProjectById: jest.fn().mockResolvedValue(null),
    findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
    findVcsConnectionById: jest.fn().mockResolvedValue(null),
    findPollingConnections: jest.fn().mockResolvedValue([]),
    createVcsConnection: jest.fn(),
    updateVcsConnection: jest.fn(),
    updateVcsConnectionLastSynced: jest.fn().mockResolvedValue(undefined),
    deleteVcsConnection: jest.fn().mockResolvedValue(undefined),
    createVcsSyncLog: jest.fn().mockResolvedValue({} as never),
    findPendingOutboxEvents: jest.fn().mockResolvedValue([]),
  } as jest.Mocked<IVcsRepository>;
}

describe('VcsSyncService', () => {
  let service: VcsSyncService;
  let mockRepo: jest.Mocked<IVcsRepository>;

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

      const result = await service.syncIssue(project, issue, 'manual');

      expect(result.action).toBe('created');
      expect(result.ticketId).toBe('t-1');
      expect(result.ticketNumber).toBe(5);
      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledWith(
        project,
        expect.objectContaining({ number: issue.number }),
      );
    });

    it('should skip when a ticket with the same external VCS ID already exists', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 42 });

      mockRepo.findExistingTicketByExternalId.mockResolvedValue({ id: 'existing-t' } as any);

      const result = await service.syncIssue(project, issue, 'polling');

      expect(result.action).toBe('skipped');
      expect(mockRepo.createTicketFromIssue).not.toHaveBeenCalled();
    });

    it('should look up the external ID using the string form of the issue number', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 99 });

      await service.syncIssue(project, issue, 'webhook');

      expect(mockRepo.findExistingTicketByExternalId).toHaveBeenCalledWith(project.id, '99');
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
        fetchIssues: jest.fn().mockResolvedValue([
          makeIssue({ number: 1, title: 'Issue 1' }),
          makeIssue({ number: 2, title: 'Issue 2' }),
        ]),
        testConnection: jest.fn(),
        fetchIssue: jest.fn(),
        getPullRequestStatus: jest.fn(),
        listPrCommits: jest.fn(),
      };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

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
        fetchIssues: jest.fn().mockResolvedValue([makeIssue({ number: 1 })]),
        testConnection: jest.fn(),
        fetchIssue: jest.fn(),
        getPullRequestStatus: jest.fn(),
        listPrCommits: jest.fn(),
      };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

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
        fetchIssues: jest.fn().mockResolvedValue([
          makeIssue({ number: 1 }),
          makeIssue({ number: 2 }),
        ]),
        testConnection: jest.fn(),
        fetchIssue: jest.fn(),
        getPullRequestStatus: jest.fn(),
        listPrCommits: jest.fn(),
      };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

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
        fetchIssues: jest.fn().mockRejectedValue(new Error('Network error')),
        testConnection: jest.fn(),
        fetchIssue: jest.fn(),
        getPullRequestStatus: jest.fn(),
        listPrCommits: jest.fn(),
      };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Sync failed');
      expect(result.issuesSynced).toBe(0);
    });
  });
});
