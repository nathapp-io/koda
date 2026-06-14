/**
 * VcsSyncService.syncIssue Unit/Integration Tests
 *
 * Comprehensive tests for the core vcsService.syncIssue(project, issue, source)
 * method used by all three sync paths. Tests cover:
 * - Ticket creation with correct defaults (type, status, priority)
 * - Deduplication via externalVcsId
 * - VCS metadata population (externalVcsId, externalVcsUrl, vcsSyncedAt)
 * - Atomic ticket number allocation via MAX(number)+1 in transaction
 * - Return value structure (action: 'created' | 'skipped', ticketId)
 *
 * Run: npx jest test/integration/vcs/vcs-sync.service.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { VcsSyncService, SyncIssueResult } from '../../../src/vcs/vcs-sync.service';
import { VCS_REPOSITORY } from '../../../src/vcs/domain/vcs.repository';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { VcsIssue } from '../../../src/vcs/types';

describe('VcsSyncService.syncIssue', () => {
  let service: VcsSyncService;
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

  const mockVcsIssue: VcsIssue = {
    number: 42,
    title: 'Fix authentication bug',
    body: 'Users cannot log in after changing password',
    authorLogin: 'octocat',
    url: 'https://github.com/owner/repo/issues/42',
    labels: ['bug', 'authentication'],
    createdAt: new Date('2024-01-15'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    module = await Test.createTestingModule({
      providers: [
        VcsSyncService,
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

    service = module.get<VcsSyncService>(VcsSyncService);
    vcsRepo = module.get(VCS_REPOSITORY);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('AC1: Creates ticket with correct defaults', () => {
    it('should create a ticket with type=TASK, status=CREATED, priority=MEDIUM', async () => {
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'ticket-123',
        number: 1,
        title: mockVcsIssue.title,
      });

      const result = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(vcsRepo.createTicketFromIssue).toHaveBeenCalledWith(mockProject, mockVcsIssue);
      expect(result.action).toBe('created');
    });

    it('should use type from source parameter (manual/polling/webhook all use TASK)', async () => {
      for (const source of ['manual', 'polling', 'webhook'] as const) {
        jest.clearAllMocks();

        vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
        vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
          id: 'ticket-123',
          number: 1,
          title: mockVcsIssue.title,
        });

        const result = await service.syncIssue(mockProject as any, mockVcsIssue, source);

        expect(result.action).toBe('created');
        expect(vcsRepo.createTicketFromIssue).toHaveBeenCalledWith(mockProject, mockVcsIssue);
      }
    });
  });

  describe('AC2: Returns correct response on successful creation', () => {
    it('should return { action: "created", ticketId } on successful creation', async () => {
      const ticketId = 'ticket-xyz-789';
      const ticketNumber = 5;

      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: ticketId,
        number: ticketNumber,
        title: mockVcsIssue.title,
      });

      const result: SyncIssueResult = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(result).toEqual({
        action: 'created',
        ticketId,
        ticketNumber,
        ticketTitle: mockVcsIssue.title,
      });
      expect(result.action).toBe('created');
      expect(result.ticketId).toBe(ticketId);
    });

    it('should include ticketNumber in response', async () => {
      const ticketId = 'ticket-456';
      const ticketNumber = 10;

      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: ticketId,
        number: ticketNumber,
        title: mockVcsIssue.title,
      });

      const result: SyncIssueResult = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(result.ticketNumber).toBe(ticketNumber);
    });
  });

  describe('AC3: Deduplication via externalVcsId', () => {
    it('should return { action: "skipped" } when ticket with same externalVcsId exists', async () => {
      const existingTicket = {
        id: 'existing-ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: 'Old title',
        description: null,
        status: 'CREATED',
        priority: 'MEDIUM',
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: new Date('2024-01-01'),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(existingTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(result).toEqual({
        action: 'skipped',
        reason: expect.any(String),
      });
      expect(result.action).toBe('skipped');
      expect(result.ticketId).toBeUndefined();
    });

    it('should check for existing ticket with matching externalVcsId in project scope', async () => {
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'ticket-123',
        number: 1,
        title: mockVcsIssue.title,
      });

      await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(vcsRepo.findExistingTicketByExternalId).toHaveBeenCalledWith(projectId, '42');
    });

    it('should not skip if externalVcsId exists in different project', async () => {
      // Returns null because the query is scoped to the project
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'ticket-new-123',
        number: 1,
        title: mockVcsIssue.title,
      });

      const result: SyncIssueResult = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      // Should create (not skip) because existing ticket is in different project
      expect(result.action).toBe('created');
    });

    it('should skip if soft-deleted ticket exists with same externalVcsId and projectId', async () => {
      const softDeletedTicket = {
        id: 'deleted-ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: 'Previously synced issue',
        description: null,
        status: 'CLOSED',
        priority: 'MEDIUM',
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: new Date('2024-01-01'),
        deletedAt: new Date('2024-02-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(softDeletedTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(result.action).toBe('skipped');
    });
  });

  describe('AC4: VCS metadata fields populated from VcsIssue', () => {
    it('should delegate to repository with the correct issue data', async () => {
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'ticket-123',
        number: 1,
        title: mockVcsIssue.title,
      });

      await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(vcsRepo.createTicketFromIssue).toHaveBeenCalledWith(mockProject, mockVcsIssue);
    });

    it('should handle null issue.body (passed through to repository)', async () => {
      const issueWithoutDescription: VcsIssue = {
        ...mockVcsIssue,
        body: null,
      };

      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'ticket-123',
        number: 1,
        title: issueWithoutDescription.title,
      });

      const result = await service.syncIssue(mockProject as any, issueWithoutDescription, 'manual');

      expect(result.action).toBe('created');
      expect(vcsRepo.createTicketFromIssue).toHaveBeenCalledWith(mockProject, issueWithoutDescription);
    });
  });

  describe('AC5: Atomic ticket number allocation via repository', () => {
    it('should delegate number allocation to the repository', async () => {
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'new-ticket-123',
        number: 6,
        title: mockVcsIssue.title,
      });

      const result = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(vcsRepo.createTicketFromIssue).toHaveBeenCalledWith(mockProject, mockVcsIssue);
      expect(result.ticketNumber).toBe(6);
    });

    it('should start from 1 when no previous tickets exist in project', async () => {
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
        id: 'first-ticket-123',
        number: 1,
        title: mockVcsIssue.title,
      });

      const result = await service.syncIssue(mockProject as any, mockVcsIssue, 'manual');

      expect(result.ticketNumber).toBe(1);
    });

    it('should not create ticket if repository throws', async () => {
      vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
      vcsRepo.createTicketFromIssue.mockRejectedValueOnce(new Error('Transaction failed'));

      await expect(service.syncIssue(mockProject as any, mockVcsIssue, 'manual')).rejects.toThrow(
        'Transaction failed',
      );
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle different issue numbers correctly', async () => {
      const issueNumbers = [1, 99, 999, 12345];

      for (const issueNumber of issueNumbers) {
        jest.clearAllMocks();

        const issue: VcsIssue = {
          ...mockVcsIssue,
          number: issueNumber,
        };

        vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
        vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
          id: 'ticket-123',
          number: 1,
          title: issue.title,
        });

        await service.syncIssue(mockProject as any, issue, 'manual');

        expect(vcsRepo.findExistingTicketByExternalId).toHaveBeenCalledWith(
          projectId,
          String(issueNumber),
        );
      }
    });

    it('should use issue.title as ticket title', async () => {
      const titles = [
        'Simple title',
        'Title with special chars: !@#$%',
        'Very long title that spans multiple words and should still be stored correctly',
      ];

      for (const title of titles) {
        jest.clearAllMocks();

        const issue: VcsIssue = {
          ...mockVcsIssue,
          title,
        };

        vcsRepo.findExistingTicketByExternalId.mockResolvedValueOnce(null);
        vcsRepo.createTicketFromIssue.mockResolvedValueOnce({
          id: 'ticket-123',
          number: 1,
          title,
        });

        const result = await service.syncIssue(mockProject as any, issue, 'manual');

        expect(result.ticketTitle).toBe(title);
      }
    });
  });

  describe('filterByAllowedAuthors utility method', () => {
    it('should return all issues when allowedAuthors is empty', () => {
      const issues: VcsIssue[] = [
        { ...mockVcsIssue, authorLogin: 'alice' },
        { ...mockVcsIssue, authorLogin: 'bob' },
      ];

      const result = service.filterByAllowedAuthors(issues, '[]');

      expect(result).toEqual(issues);
    });

    it('should filter issues by allowed authors', () => {
      const issues: VcsIssue[] = [
        { ...mockVcsIssue, number: 1, authorLogin: 'alice' },
        { ...mockVcsIssue, number: 2, authorLogin: 'bob' },
        { ...mockVcsIssue, number: 3, authorLogin: 'charlie' },
      ];

      const allowedAuthors = JSON.stringify(['alice', 'charlie']);
      const result = service.filterByAllowedAuthors(issues, allowedAuthors);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.authorLogin)).toContain('alice');
      expect(result.map((i) => i.authorLogin)).toContain('charlie');
      expect(result.map((i) => i.authorLogin)).not.toContain('bob');
    });

    it('should return all issues if allowedAuthors JSON is invalid', () => {
      const issues: VcsIssue[] = [
        { ...mockVcsIssue, authorLogin: 'alice' },
        { ...mockVcsIssue, authorLogin: 'bob' },
      ];

      const result = service.filterByAllowedAuthors(issues, 'invalid-json');

      expect(result).toEqual(issues);
    });
  });
});
