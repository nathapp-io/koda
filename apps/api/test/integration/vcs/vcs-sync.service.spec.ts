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
import { PrismaService } from '@nathapp/nestjs-prisma';
import { VcsSyncService, SyncIssueResult } from '../../../src/vcs/vcs-sync.service';
import { VcsIssue } from '../../../src/vcs/types';

describe('VcsSyncService.syncIssue', () => {
  let service: VcsSyncService;
  let prismaService: PrismaService;
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

  const mockTicketDelegate = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  };

  const mockClient = {
    ticket: { ...mockTicketDelegate },
    $transaction: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    module = await Test.createTestingModule({
      providers: [
        VcsSyncService,
        {
          provide: PrismaService,
          useValue: {
            client: mockClient,
          },
        },
      ],
    }).compile();

    service = module.get<VcsSyncService>(VcsSyncService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('AC1: Creates ticket with correct defaults', () => {
    it('should create a ticket with type=TASK, status=CREATED, priority=MEDIUM', async () => {
      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      // Mock: no existing ticket
      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      // Mock transaction
      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // No existing tickets
          return callback(prismaService.client);
        },
      );

      // Mock create to return the expected ticket
      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      const result = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Verify the create call was made with correct ticket data
      expect(mockTicketDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId,
            number: expect.any(Number),
            type: 'TASK',
            title: mockVcsIssue.title,
            description: mockVcsIssue.body,
            status: 'CREATED',
            priority: 'MEDIUM',
            externalVcsId: '42',
            externalVcsUrl: mockVcsIssue.url,
            vcsSyncedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should use type from source parameter (manual/polling/webhook all use TASK)', async () => {
      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      for (const source of ['manual', 'polling', 'webhook'] as const) {
        jest.clearAllMocks();

        mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
        ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
          async (callback: (client: any) => Promise<any>) => {
            mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
            return callback(prismaService.client);
          },
        );
        mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

        await service.syncIssue(mockProject, mockVcsIssue, source);

        expect(mockTicketDelegate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              type: 'TASK',
            }),
          }),
        );
      }
    });
  });

  describe('AC2: Returns correct response on successful creation', () => {
    it('should return { action: "created", ticketId } on successful creation', async () => {
      const ticketId = 'ticket-xyz-789';
      const ticketNumber = 5;

      const createdTicket = {
        id: ticketId,
        projectId,
        number: ticketNumber,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      expect(result).toEqual({
        action: 'created',
        ticketId,
        ticketNumber,
      });
      expect(result.action).toBe('created');
      expect(result.ticketId).toBe(ticketId);
    });

    it('should include ticketNumber in response', async () => {
      const ticketId = 'ticket-456';
      const ticketNumber = 10;

      const createdTicket = {
        id: ticketId,
        projectId,
        number: ticketNumber,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

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
        externalVcsId: '42', // Same as the issue we're syncing
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: new Date('2024-01-01'),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock: ticket already exists
      mockTicketDelegate.findFirst.mockResolvedValueOnce(existingTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      expect(result).toEqual({
        action: 'skipped',
        reason: expect.any(String),
      });
      expect(result.action).toBe('skipped');
      expect(result.ticketId).toBeUndefined();
    });

    it('should check for existing ticket with matching externalVcsId in project scope', async () => {
      mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // No existing ticket

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Verify deduplication check was done with correct filters
      expect(mockTicketDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId,
            externalVcsId: '42',
            deletedAt: null,
          }),
        }),
      );
    });

    it('should not skip if externalVcsId exists in different project', async () => {
      // This test verifies project-scope isolation
      const otherProjectTicket = {
        id: 'other-project-ticket',
        projectId: 'other-project-456',
        number: 1,
        type: 'TASK',
        title: 'Different project ticket',
        description: null,
        status: 'CREATED',
        priority: 'MEDIUM',
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: new Date(),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // First call checks for existing in projectId (finds none)
      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      const createdTicket = {
        id: 'ticket-new-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Should create (not skip) because existing ticket is in different project
      expect(result.action).toBe('created');
    });

    it('should skip if soft-deleted ticket exists with same externalVcsId and projectId', async () => {
      // This is important: soft-deleted tickets should still prevent duplication
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
        deletedAt: new Date('2024-02-01'), // Soft deleted
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(softDeletedTicket);

      const result: SyncIssueResult = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      expect(result.action).toBe('skipped');
    });
  });

  describe('AC4: VCS metadata fields populated from VcsIssue', () => {
    it('should set externalVcsId from issue.number', async () => {
      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      expect(mockTicketDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            externalVcsId: String(mockVcsIssue.number), // Should be stringified
          }),
        }),
      );
    });

    it('should set externalVcsUrl from issue.url', async () => {
      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      expect(mockTicketDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            externalVcsUrl: mockVcsIssue.url,
          }),
        }),
      );
    });

    it('should set vcsSyncedAt to current timestamp', async () => {
      const beforeCall = new Date();

      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: new Date(),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      const afterCall = new Date();

      expect(mockTicketDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            vcsSyncedAt: expect.any(Date),
          }),
        }),
      );

      const createCall = mockTicketDelegate.create.mock.calls[0][0];
      const vcsSyncedAt = createCall.data.vcsSyncedAt;
      expect(vcsSyncedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(vcsSyncedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('should use issue.body as ticket description', async () => {
      const issueWithDescription: VcsIssue = {
        ...mockVcsIssue,
        body: 'Detailed description of the issue',
      };

      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: issueWithDescription.title,
        description: issueWithDescription.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: issueWithDescription.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      await service.syncIssue(mockProject, issueWithDescription, 'manual');

      expect(mockTicketDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: issueWithDescription.body,
          }),
        }),
      );
    });

    it('should handle null issue.body', async () => {
      const issueWithoutDescription: VcsIssue = {
        ...mockVcsIssue,
        body: null,
      };

      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: issueWithoutDescription.title,
        description: null,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: issueWithoutDescription.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          return callback(prismaService.client);
        },
      );

      mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);

      await service.syncIssue(mockProject, issueWithoutDescription, 'manual');

      expect(mockTicketDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: null,
          }),
        }),
      );
    });
  });

  describe('AC5: Atomic ticket number allocation in transaction', () => {
    it('should allocate ticket.number as MAX(number)+1 scoped to project', async () => {
      const lastTicketInProject = {
        id: 'last-ticket-id',
        projectId,
        number: 5,
        type: 'TASK',
        title: 'Previous ticket',
        description: null,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '41',
        externalVcsUrl: 'https://github.com/owner/repo/issues/41',
        vcsSyncedAt: new Date(),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createdTicket = {
        id: 'new-ticket-123',
        projectId,
        number: 6, // MAX(5) + 1
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // Deduplication check

      let transactionCallbackArg: (client: any) => Promise<any>;
      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          transactionCallbackArg = callback;
          mockTicketDelegate.findFirst.mockResolvedValueOnce(lastTicketInProject); // In transaction
          mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
          return callback(prismaService.client);
        },
      );

      const result = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Verify transaction was used
      expect((prismaService.client as any).$transaction).toHaveBeenCalled();

      // Verify correct number allocation
      expect(result.ticketNumber).toBe(6);

      // Verify findFirst was called to get max number
      expect(mockTicketDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId,
          }),
          orderBy: { number: 'desc' },
        }),
      );
    });

    it('should start from 1 when no previous tickets exist in project', async () => {
      const createdTicket = {
        id: 'first-ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // Deduplication check

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // No existing tickets
          mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
          return callback(prismaService.client);
        },
      );

      const result = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // First ticket should be number 1
      expect(result.ticketNumber).toBe(1);
    });

    it('should use transaction to prevent concurrent duplicate numbers', async () => {
      const createdTicket = {
        id: 'ticket-123',
        projectId,
        number: 1,
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // Deduplication check

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          // Verify callback receives the transactional client
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
          mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
          return callback(prismaService.client);
        },
      );

      await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Verify that $transaction was called, ensuring atomicity
      expect((prismaService.client as any).$transaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should scope ticket number allocation to project', async () => {
      // Create tickets in different projects
      const otherProjectLastTicket = {
        id: 'other-project-ticket',
        projectId: 'other-project-456',
        number: 100,
        type: 'TASK',
        title: 'Other project ticket',
        description: null,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: 'other-42',
        externalVcsUrl: 'https://github.com/owner/repo/issues/42',
        vcsSyncedAt: new Date(),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createdTicket = {
        id: 'ticket-123',
        projectId, // Current project, not the "other" project
        number: 1, // Should be 1, not 101
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // Deduplication check

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // No tickets in projectId
          mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
          return callback(prismaService.client);
        },
      );

      const result = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Should be 1, not 101 (other project's max + 1)
      expect(result.ticketNumber).toBe(1);

      // Verify findFirst was scoped to the project
      expect(mockTicketDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId, // Scoped to current project
          }),
        }),
      );
    });

    it('should include soft-deleted tickets when calculating MAX(number)', async () => {
      // This is important: soft-deleted tickets count toward number allocation
      const lastTicket = {
        id: 'deleted-ticket-999',
        projectId,
        number: 10,
        type: 'TASK',
        title: 'Previously synced and then deleted',
        description: null,
        status: 'CLOSED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: 'old-issue',
        externalVcsUrl: 'https://github.com/owner/repo/issues/999',
        vcsSyncedAt: new Date(),
        deletedAt: new Date(), // Soft deleted
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createdTicket = {
        id: 'new-ticket-123',
        projectId,
        number: 11, // Should be 10 + 1, even though previous is soft-deleted
        type: 'TASK',
        title: mockVcsIssue.title,
        description: mockVcsIssue.body,
        status: 'CREATED',
        priority: 'MEDIUM',
        assignedToUserId: null,
        assignedToAgentId: null,
        createdByUserId: null,
        createdByAgentId: null,
        gitRefVersion: null,
        gitRefFile: null,
        gitRefLine: null,
        externalVcsId: '42',
        externalVcsUrl: mockVcsIssue.url,
        vcsSyncedAt: expect.any(Date),
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      };

      mockTicketDelegate.findFirst.mockResolvedValueOnce(null); // Deduplication check

      ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
        async (callback: (client: any) => Promise<any>) => {
          mockTicketDelegate.findFirst.mockResolvedValueOnce(lastTicket); // Returns soft-deleted ticket
          mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
          return callback(prismaService.client);
        },
      );

      const result = await service.syncIssue(mockProject, mockVcsIssue, 'manual');

      // Should be 11 (considering soft-deleted ticket)
      expect(result.ticketNumber).toBe(11);
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

        const createdTicket = {
          id: 'ticket-123',
          projectId,
          number: 1,
          type: 'TASK',
          title: issue.title,
          description: issue.body,
          status: 'CREATED',
          priority: 'MEDIUM',
          assignedToUserId: null,
          assignedToAgentId: null,
          createdByUserId: null,
          createdByAgentId: null,
          gitRefVersion: null,
          gitRefFile: null,
          gitRefLine: null,
          externalVcsId: String(issueNumber),
          externalVcsUrl: issue.url,
          vcsSyncedAt: expect.any(Date),
          deletedAt: null,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        };

        mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

        ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
          async (callback: (client: any) => Promise<any>) => {
            mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
            mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
            return callback(prismaService.client);
          },
        );

        await service.syncIssue(mockProject, issue, 'manual');

        // Verify externalVcsId is set to stringified issue number
        expect(mockTicketDelegate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              externalVcsId: String(issueNumber),
            }),
          }),
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

        const createdTicket = {
          id: 'ticket-123',
          projectId,
          number: 1,
          type: 'TASK',
          title,
          description: issue.body,
          status: 'CREATED',
          priority: 'MEDIUM',
          assignedToUserId: null,
          assignedToAgentId: null,
          createdByUserId: null,
          createdByAgentId: null,
          gitRefVersion: null,
          gitRefFile: null,
          gitRefLine: null,
          externalVcsId: '42',
          externalVcsUrl: issue.url,
          vcsSyncedAt: expect.any(Date),
          deletedAt: null,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        };

        mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

        ((prismaService.client as any).$transaction as jest.Mock).mockImplementation(
          async (callback: (client: any) => Promise<any>) => {
            mockTicketDelegate.findFirst.mockResolvedValueOnce(null);
            mockTicketDelegate.create.mockResolvedValueOnce(createdTicket);
            return callback(prismaService.client);
          },
        );

        await service.syncIssue(mockProject, issue, 'manual');

        expect(mockTicketDelegate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              title,
            }),
          }),
        );
      }
    });

    it('should not create ticket if transaction fails', async () => {
      mockTicketDelegate.findFirst.mockResolvedValueOnce(null);

      const transactionError = new Error('Transaction failed');
      ((prismaService.client as any).$transaction as jest.Mock).mockRejectedValueOnce(transactionError);

      await expect(service.syncIssue(mockProject, mockVcsIssue, 'manual')).rejects.toThrow(
        transactionError,
      );

      // Ensure create was not called successfully
      expect(mockTicketDelegate.create).not.toHaveBeenCalled();
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
