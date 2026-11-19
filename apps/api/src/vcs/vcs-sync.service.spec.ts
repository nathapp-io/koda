import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { VcsSyncService, VcsTargetDriftError } from './vcs-sync.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsIssue } from './types';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';

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
    updateTicketLinkWithPrState: vi.fn().mockResolvedValue({ result: 'updated', previousState: null }),
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
  const auditRecord = vi.mocked(mockAuditRecorder.record);

  it('AC-10: strict syncIssues propagates the first write error and stops', async () => {
    const error = new Error('write failed');
    mockRepo.createTicketFromIssue.mockRejectedValue(error);
    await expect(service.syncIssues(makeProject(), [makeIssue(), makeIssue({ number: 2 })], makeConnection(), 'vcs.sync.all', { isolate: false })).rejects.toBe(error);
    expect(mockRepo.createTicketFromIssue).toHaveBeenCalledOnce();
  });

  beforeEach(async () => {
    mockRepo = createMockRepo();
    auditRecord.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsSyncService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
        { provide: AuditRecorder, useValue: mockAuditRecorder },
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

      const result = await service.syncIssue(project, issue, 'manual', makeConnection(), 'vcs.sync.issue');

      expect(result.action).toBe('created');
      expect(result.ticketId).toBe('t-1');
      expect(result.ticketNumber).toBe(5);
      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledWith(
        project,
        expect.objectContaining({ number: issue.number }),
        'owner/repo#1',
        expect.any(Function),
        undefined,
      );
    });

    it('should skip when a ticket with the same external VCS ID already exists', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 42 });

      mockRepo.findExistingTicketByExternalId.mockResolvedValue({ id: 'existing-t' } as any);

      const result = await service.syncIssue(project, issue, 'polling', makeConnection(), 'system.vcs.poll-issues');

      expect(result.action).toBe('skipped');
      expect(mockRepo.createTicketFromIssue).not.toHaveBeenCalled();
    });

    it('should look up the external ID using the string form of the issue number', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 99 });

      await service.syncIssue(project, issue, 'webhook', makeConnection(), 'system.vcs.webhook-intake');

      expect(mockRepo.findExistingTicketByExternalId).toHaveBeenCalledWith(project.id, 'owner/repo#99');
    });

    it('AC-21: records the import on the new ticket with the caller key and the issue number', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 7 });
      mockRepo.findExistingTicketByExternalId.mockResolvedValue(null);
      mockRepo.createTicketFromIssue.mockImplementation(async (_project, _issue, _externalVcsId, onCreated) => {
        await onCreated?.({ id: 't-1', number: 3 });
        return { id: 't-1', number: 3, title: 'Test issue' };
      });

      await service.syncIssue(project, issue, 'manual', makeConnection(), 'vcs.sync.issue');

      expect(auditRecord).toHaveBeenCalledTimes(1);
      expect(auditRecord).toHaveBeenCalledWith({
        key: 'vcs.sync.issue',
        resourceType: 'ticket',
        resourceId: 't-1',
        projectId: project.id,
        summary: 'imported issue #7',
      });
    });

    it('records nothing for an issue that was already imported', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 42 });

      mockRepo.findExistingTicketByExternalId.mockResolvedValue({ id: 'existing-t' } as never);

      await service.syncIssue(project, issue, 'polling', makeConnection(), 'system.vcs.poll-issues');

      expect(auditRecord).not.toHaveBeenCalled();
    });

    it('AC-7: answers skipped when the insert lost the import race outside a transaction', async () => {
      const project = makeProject();
      const issue = makeIssue({ number: 12 });
      mockRepo.findExistingTicketByExternalId.mockResolvedValue(null);
      // The unique index rejected this insert: another import of the same issue won after the pre-check.
      mockRepo.createTicketFromIssue.mockResolvedValue(null);

      const result = await service.syncIssue(project, issue, 'webhook', makeConnection(), 'system.vcs.webhook-intake');

      expect(result).toEqual({ action: 'skipped', reason: 'Ticket with this external VCS ID already exists' });
      expect(auditRecord).not.toHaveBeenCalled();
    });
  });

  describe('M11: repo-qualified external ids', () => {
    it('dedups and creates with owner/repo#N', async () => {
      const repo = {
        findExistingTicketByExternalId: vi.fn().mockResolvedValue(null),
        createTicketFromIssue: vi.fn().mockResolvedValue({ id: 't1', number: 1, title: 'Issue' }),
      };
      const service = new VcsSyncService(
        repo as unknown as IVcsRepository,
        mockAuditRecorder as never,
      );
      const issue = { number: 5, title: 'Issue', body: null, authorLogin: 'a', url: 'u', labels: [], createdAt: new Date() };

      await service.syncIssue({ id: 'p1' }, issue, 'polling', { repoOwner: 'acme', repoName: 'widgets' }, 'vcs.sync.all');

      expect(repo.findExistingTicketByExternalId).toHaveBeenCalledWith('p1', 'acme/widgets#5');
      expect(repo.createTicketFromIssue).toHaveBeenCalledWith(
        { id: 'p1' }, issue, 'acme/widgets#5', expect.any(Function), undefined,
      );
    });
  });

  /**
   * Review-1119 US-006 (B1): a deferred import writes after the approval committed, so the connection
   * lock its target check held is gone. Each issue write revalidates the captured target in its own
   * transaction; the first refusal means every remaining write would be refused too.
   */
  describe('B1: per-write target revalidation', () => {
    const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 }), makeIssue({ number: 3 })];

    /** The repository side of the contract: the revalidation runs inside the write it guards. */
    const revalidateInsideWrite = () => mockRepo.createTicketFromIssue.mockImplementation(
      async (_project, _issue, _externalVcsId, _onCreated, beforeInsert) => {
        await beforeInsert?.();
        return { id: 't-1', number: 1, title: 'Test issue' };
      },
    );

    it('hands the revalidation to every issue write', async () => {
      const revalidate = vi.fn().mockResolvedValue(undefined);
      revalidateInsideWrite();

      await service.syncIssues(makeProject(), issues, makeConnection(), 'vcs.sync.all', { isolate: true, revalidate });

      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledTimes(3);
      for (const call of mockRepo.createTicketFromIssue.mock.calls) {
        expect(call[4]).toBe(revalidate);
      }
    });

    it('stops at the first drift refusal and reports it once instead of once per issue', async () => {
      const drift = new VcsTargetDriftError();
      const revalidate = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(drift);
      revalidateInsideWrite();

      const result = await service.syncIssues(
        makeProject(), issues, makeConnection(), 'vcs.sync.all', { isolate: true, revalidate },
      );

      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledTimes(2);
      expect(result.issuesSynced).toBe(1);
      expect(result.stopped).toBe(drift.message);
      expect(result.errors).toEqual([]);
    });

    /**
     * Review-1119 US-006 (B1): the caller logs `errors` truncated to ten entries, so a drift behind ten
     * ordinary failures was only ever printed as "and 1 more", its reason lost. The refusal travels beside
     * the summary now.
     */
    it('B1: reports the drift beside ten ordinary failures, not as an eleventh summary entry', async () => {
      const drift = new VcsTargetDriftError();
      const many = Array.from({ length: 11 }, (_, index) => makeIssue({ number: index + 1 }));
      const revalidate = vi.fn().mockRejectedValue(drift);
      // Ten ordinary issue writes fail before the eleventh reaches its revalidation and is refused.
      let writes = 0;
      mockRepo.createTicketFromIssue.mockImplementation(async (_project, _issue, _externalVcsId, _onCreated, beforeInsert) => {
        writes++;
        if (writes <= 10) throw new Error('write failed');
        await beforeInsert?.();
        return { id: 't-11', number: 11, title: 'Test issue' };
      });

      const result = await service.syncIssues(
        makeProject(), many, makeConnection(), 'vcs.sync.all', { isolate: true, revalidate },
      );

      expect(result.errors).toHaveLength(10);
      expect(result.errors[0]).toBe('Issue 1: write failed');
      expect(result.errors).not.toContainEqual(expect.stringContaining(drift.message));
      expect(result.stopped).toBe(drift.message);
      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledTimes(11);
    });

    it('keeps an ordinary write failure per issue and continues the pass', async () => {
      const revalidate = vi.fn().mockResolvedValue(undefined);
      mockRepo.createTicketFromIssue.mockImplementation(async (_project, issue, _externalVcsId, _onCreated, beforeInsert) => {
        await beforeInsert?.();
        if (issue.number === 2) throw new Error('audit down');
        return { id: 't-1', number: 1, title: 'Test issue' };
      });

      const result = await service.syncIssues(
        makeProject(), issues, makeConnection(), 'vcs.sync.all', { isolate: true, revalidate },
      );

      expect(mockRepo.createTicketFromIssue).toHaveBeenCalledTimes(3);
      expect(result.errors).toEqual(['Issue 2: audit down']);
      expect(result.stopped).toBeUndefined();
      expect(result.issuesSynced).toBe(2);
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

    it('AC-29: lists an issue whose audit recording failed and keeps going', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';
      const mockProvider = {
        fetchIssues: vi.fn().mockResolvedValue({ issues: [makeIssue({ number: 13 })], cursor: null, capped: false }),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);
      mockRepo.findExistingTicketByExternalId.mockResolvedValue(null);
      mockRepo.createTicketFromIssue.mockImplementation(async (_project, _issue, _externalVcsId, onCreated) => {
        await onCreated?.({ id: 't-13', number: 13 });
        return { id: 't-13', number: 13, title: 'Issue 13' };
      });
      auditRecord.mockRejectedValueOnce(new Error('audit down'));

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result.errors).toContain('Issue 13: audit down');
      expect(result.issuesSynced).toBe(0);
      expect(result.issuesSkipped).toBe(1);
      expect(result.createdTickets).toEqual([]);
    });

    it('Review f-ee6758e4: propagates a rejected fetch instead of reporting an empty import', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';

      const mockProvider = {
        fetchIssues: vi.fn().mockRejectedValue(new Error('Invalid next page in the Link header')),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      await expect(service.fullSync(project, connection, encryptionKey))
        .rejects.toThrow('Invalid next page in the Link header');
    });

    it('Review f-ee6758e4: an empty repository still resolves an empty sync, not a failure', async () => {
      const project = makeProject();
      const connection = makeConnection({ allowedAuthors: '[]' });
      const encryptionKey = 'test-key-32-chars-exactly-padded!!';

      const mockProvider = {
        fetchIssues: vi.fn().mockResolvedValue({ issues: [], cursor: null, capped: false }),
        testConnection: vi.fn(),
        fetchIssue: vi.fn(),
        getPullRequestStatus: vi.fn(),
        listPrCommits: vi.fn(),
      };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      const result = await service.fullSync(project, connection, encryptionKey);

      expect(result).toMatchObject({ issuesSynced: 0, issuesSkipped: 0, createdTickets: [], errors: [] });
    });
  });
});
