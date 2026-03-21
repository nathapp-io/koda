import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TicketStatus, CommentType, ActivityType, PrismaClient } from '@prisma/client';
import { TicketTransitionsService } from './ticket-transitions.service';
import { AppException } from '/nestjs-common';

describe('TicketTransitionsService', () => {
  let service: TicketTransitionsService;
  let prismaService: PrismaService<PrismaClient>;

  const mockProject = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockUser = {
    id: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    role: 'MEMBER',
    passwordHash: 'hash',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: 'Users cannot login',
    status: TicketStatus.CREATED,
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: 'user-123',
    createdByAgentId: null,
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    gitRefUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockComment = {
    id: 'comment-123',
    ticketId: 'ticket-123',
    body: 'This is verified',
    type: CommentType.VERIFICATION,
    authorUserId: 'user-123',
    authorAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockActivity = {
    id: 'activity-123',
    ticketId: 'ticket-123',
    action: ActivityType.STATUS_CHANGE,
    fromStatus: TicketStatus.CREATED,
    toStatus: TicketStatus.VERIFIED,
    field: null,
    oldValue: null,
    newValue: null,
    actorUserId: 'user-123',
    actorAgentId: null,
    createdAt: new Date(),
  };

  const mockPrismaClient = {
    project: {
      findUnique: jest.fn(),
    },
    ticket: {
      findUnique: jest.fn(),
    },
    comment: {
      create: jest.fn(),
    },
    ticketActivity: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketTransitionsService,
        {
          provide: 'PrismaService',
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<TicketTransitionsService>(TicketTransitionsService);
    prismaService = module.get<any>('PrismaService');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('verify (CREATED → VERIFIED)', () => {
    it('should transition ticket from CREATED to VERIFIED with VERIFICATION comment', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment, type: CommentType.VERIFICATION },
        activity: { ...mockActivity, toStatus: TicketStatus.VERIFIED },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'This is verified',
        { sub: 'user-123' },
        'user'
      );

      expect(result.ticket.status).toBe(TicketStatus.VERIFIED);
      expect(result.comment.type).toBe(CommentType.VERIFICATION);
      expect(result.activity.action).toBe(ActivityType.STATUS_CHANGE);
      expect(result.activity.fromStatus).toBe(TicketStatus.CREATED);
      expect(result.activity.toStatus).toBe(TicketStatus.VERIFIED);
    });

    it('should create a comment with correct type and actor', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment, type: CommentType.VERIFICATION, authorUserId: 'user-123' },
        activity: { ...mockActivity },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      await service.verify(
        'koda',
        'KODA-1',
        'This is verified',
        { sub: 'user-123' },
        'user'
      );

      // Verify transaction was called to handle atomic operations
      expect(mockPrismaClient.$transaction).toHaveBeenCalled();
    });

    it('should create TicketActivity record for status change', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment },
        activity: {
          ...mockActivity,
          action: ActivityType.STATUS_CHANGE,
          fromStatus: TicketStatus.CREATED,
          toStatus: TicketStatus.VERIFIED,
        },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'This is verified',
        { sub: 'user-123' },
        'user'
      );

      expect(result.activity.action).toBe(ActivityType.STATUS_CHANGE);
      expect(result.activity.fromStatus).toBe(TicketStatus.CREATED);
      expect(result.activity.toStatus).toBe(TicketStatus.VERIFIED);
    });

    it('should throw 404 if project not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(
        service.verify('nonexistent', 'KODA-1', 'Comment', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });

    it('should throw 404 if ticket not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.verify('koda', 'KODA-999', 'Comment', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });

    it('should throw 400 if transition is invalid (not CREATED status)', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue({
        ...mockTicket,
        status: TicketStatus.IN_PROGRESS,
      });

      await expect(
        service.verify('koda', 'KODA-1', 'Comment', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });
  });

  describe('start (VERIFIED → IN_PROGRESS)', () => {
    it('should transition ticket from VERIFIED to IN_PROGRESS without comment', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const transitionResult = {
        ticket: { ...verifiedTicket, status: TicketStatus.IN_PROGRESS },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.IN_PROGRESS },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifiedTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      const result = await service.start('koda', 'KODA-1', { sub: 'user-123' }, 'user');

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
      expect(result.activity.fromStatus).toBe(TicketStatus.VERIFIED);
      expect(result.activity.toStatus).toBe(TicketStatus.IN_PROGRESS);
    });

    it('should create TicketActivity record without comment creation', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const transitionResult = {
        ticket: { ...verifiedTicket, status: TicketStatus.IN_PROGRESS },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.IN_PROGRESS },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifiedTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      await service.start('koda', 'KODA-1', { sub: 'user-123' }, 'user');

      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should throw 400 if transition is invalid (not VERIFIED status)', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket); // Still CREATED

      await expect(
        service.start('koda', 'KODA-1', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });
  });

  describe('fix (IN_PROGRESS → VERIFY_FIX)', () => {
    it('should transition from IN_PROGRESS to VERIFY_FIX with FIX_REPORT comment', async () => {
      const inProgressTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      const transitionResult = {
        ticket: { ...inProgressTicket, status: TicketStatus.VERIFY_FIX },
        comment: { ...mockComment, type: CommentType.FIX_REPORT },
        activity: { ...mockActivity, fromStatus: TicketStatus.IN_PROGRESS, toStatus: TicketStatus.VERIFY_FIX },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(inProgressTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      const result = await service.fix(
        'koda',
        'KODA-1',
        'Fixed the bug',
        { sub: 'user-123' },
        'user'
      );

      expect(result.ticket.status).toBe(TicketStatus.VERIFY_FIX);
      expect(result.comment.type).toBe(CommentType.FIX_REPORT);
      expect(result.activity.fromStatus).toBe(TicketStatus.IN_PROGRESS);
      expect(result.activity.toStatus).toBe(TicketStatus.VERIFY_FIX);
    });

    it('should create both comment and activity in transaction', async () => {
      const inProgressTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      const transitionResult = {
        ticket: { ...inProgressTicket, status: TicketStatus.VERIFY_FIX },
        comment: { ...mockComment, type: CommentType.FIX_REPORT },
        activity: { ...mockActivity, fromStatus: TicketStatus.IN_PROGRESS, toStatus: TicketStatus.VERIFY_FIX },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(inProgressTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      await service.fix(
        'koda',
        'KODA-1',
        'Fixed the bug',
        { sub: 'user-123' },
        'user'
      );

      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

  });

  describe('verifyFix (VERIFY_FIX → CLOSED or IN_PROGRESS)', () => {
    it('should transition from VERIFY_FIX to CLOSED with REVIEW comment', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const transitionResult = {
        ticket: { ...verifyFixTicket, status: TicketStatus.CLOSED },
        comment: { ...mockComment, type: CommentType.REVIEW },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.CLOSED },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifyFixTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verifyFix(
        'koda',
        'KODA-1',
        'Approved',
        true, // approve=true → CLOSED
        { sub: 'user-123' },
        'user'
      );

      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
      expect(result.comment.type).toBe(CommentType.REVIEW);
      expect(result.activity.toStatus).toBe(TicketStatus.CLOSED);
    });

    it('should transition from VERIFY_FIX to IN_PROGRESS with REVIEW comment when fix failed', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const transitionResult = {
        ticket: { ...verifyFixTicket, status: TicketStatus.IN_PROGRESS },
        comment: { ...mockComment, type: CommentType.REVIEW },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.IN_PROGRESS },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifyFixTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verifyFix(
        'koda',
        'KODA-1',
        'Fix is not working',
        false, // approve=false → IN_PROGRESS
        { sub: 'user-123' },
        'user'
      );

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
      expect(result.comment.type).toBe(CommentType.REVIEW);
      expect(result.activity.toStatus).toBe(TicketStatus.IN_PROGRESS);
    });

    it('should create both comment and activity in transaction', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const transitionResult = {
        ticket: { ...verifyFixTicket, status: TicketStatus.CLOSED },
        comment: { ...mockComment, type: CommentType.REVIEW },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.CLOSED },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifyFixTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      await service.verifyFix(
        'koda',
        'KODA-1',
        'Approved',
        true,
        { sub: 'user-123' },
        'user'
      );

      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });
  });

  describe('close (any valid → CLOSED)', () => {
    it('should close ticket from VERIFY_FIX status', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const transitionResult = {
        ticket: { ...verifyFixTicket, status: TicketStatus.CLOSED },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.CLOSED },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifyFixTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      const result = await service.close('koda', 'KODA-1', { sub: 'user-123' }, 'user');

      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
      expect(result.activity.toStatus).toBe(TicketStatus.CLOSED);
    });

    it('should throw 400 if transition is invalid', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket); // CREATED status

      await expect(
        service.close('koda', 'KODA-1', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });
  });

  describe('reject (CREATED or VERIFIED → REJECTED)', () => {
    it('should reject ticket from CREATED status with GENERAL comment', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.REJECTED },
        comment: { ...mockComment, type: CommentType.GENERAL },
        activity: { ...mockActivity, fromStatus: TicketStatus.CREATED, toStatus: TicketStatus.REJECTED },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      const result = await service.reject(
        'koda',
        'KODA-1',
        'Not valid',
        { sub: 'user-123' },
        'user'
      );

      expect(result.ticket.status).toBe(TicketStatus.REJECTED);
      expect(result.comment.type).toBe(CommentType.GENERAL);
      expect(result.activity.toStatus).toBe(TicketStatus.REJECTED);
    });

    it('should reject ticket from VERIFIED status with GENERAL comment', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const transitionResult = {
        ticket: { ...verifiedTicket, status: TicketStatus.REJECTED },
        comment: { ...mockComment, type: CommentType.GENERAL },
        activity: { ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.REJECTED },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(verifiedTicket);
      mockPrismaService.client.$transaction.mockResolvedValue(transitionResult);

      const result = await service.reject(
        'koda',
        'KODA-1',
        'Not valid',
        { sub: 'user-123' },
        'user'
      );

      expect(result.ticket.status).toBe(TicketStatus.REJECTED);
      expect(result.comment.type).toBe(CommentType.GENERAL);
    });

    it('should throw 400 if trying to reject from IN_PROGRESS', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      const inProgressTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(inProgressTicket);

      await expect(
        service.reject('koda', 'KODA-1', 'Not valid', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });

    it('should throw 400 if trying to reject from CLOSED', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      const closedTicket = { ...mockTicket, status: TicketStatus.CLOSED };
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(closedTicket);

      await expect(
        service.reject('koda', 'KODA-1', 'Not valid', { sub: 'user-123' }, 'user')
      ).rejects.toThrow(AppException);
    });
  });

  describe('Polymorphic Actor Handling', () => {
    it('should record actor as user in comment and activity when actorType is user', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment, authorUserId: 'user-123', authorAgentId: null },
        activity: { ...mockActivity, actorUserId: 'user-123', actorAgentId: null },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        { sub: 'user-123' },
        'user'
      );

      expect(result.comment.authorUserId).toBe('user-123');
      expect(result.comment.authorAgentId).toBeNull();
      expect(result.activity.actorUserId).toBe('user-123');
      expect(result.activity.actorAgentId).toBeNull();
    });

    it('should record actor as agent in comment and activity when actorType is agent', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' },
        activity: { ...mockActivity, actorUserId: null, actorAgentId: 'agent-123' },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        { sub: 'agent-123' },
        'agent'
      );

      expect(result.comment.authorUserId).toBeNull();
      expect(result.comment.authorAgentId).toBe('agent-123');
      expect(result.activity.actorUserId).toBeNull();
      expect(result.activity.actorAgentId).toBe('agent-123');
    });
  });

  describe('Transaction Atomicity', () => {
    it('should use prisma.$transaction for atomic updates', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment },
        activity: { ...mockActivity },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        { sub: 'user-123' },
        'user'
      );

      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should create comment, update status, and create activity in single transaction', async () => {
      const transitionResult = {
        ticket: { ...mockTicket, status: TicketStatus.VERIFIED },
        comment: { ...mockComment },
        activity: { ...mockActivity },
      };

      mockPrismaClient.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaClient.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaClient.$transaction.mockResolvedValue(transitionResult);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        { sub: 'user-123' },
        'user'
      );

      // All three operations should return as part of transaction
      expect(result).toHaveProperty('ticket');
      expect(result).toHaveProperty('comment');
      expect(result).toHaveProperty('activity');
      expect(prismaService.client.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
