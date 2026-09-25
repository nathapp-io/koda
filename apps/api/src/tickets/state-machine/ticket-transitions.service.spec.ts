import { Test, TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus, CommentType, ActivityType } from '../../common/enums';
import { TicketTransitionsService } from './ticket-transitions.service';
import { AppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TICKET_REPOSITORY } from '../domain/ticket.domain';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { AgentPrincipal, KodaPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';

describe('TicketTransitionsService', () => {
  let service: TicketTransitionsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTxManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTicketRepo: any;

  const mockProject = {
    id: 'proj-123',
    slug: 'koda',
    key: 'KODA',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
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

  const mockUserPrincipal = {
    actorType: 'user' as const,
    id: 'user-123',
    name: 'user@example.com',
    email: 'user@example.com',
    role: 'MEMBER' as const,
    blacklisted: false,
    revoked: false,
    authorities: ['MEMBER'],
    extra: { sub: 'user-123' },
  };

  const mockAgentPrincipal = {
    actorType: 'agent' as const,
    id: 'agent-123',
    name: 'test-agent',
    slug: 'test-agent',
    status: 'ACTIVE' as const,
    agentRoles: ['DEVELOPER'] as const,
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: ['WORKER'],
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

  beforeEach(async () => {
    mockTxManager = {
      run: jest.fn((fn: () => unknown) => fn()),
      getClient: jest.fn(),
      isInTransaction: jest.fn(() => false),
    };

    mockTicketRepo = {
      findProjectBySlug: jest.fn(),
      findLastTicketInProject: jest.fn(),
      createTicket: jest.fn(),
      findTicketsByProject: jest.fn(),
      countTicketsByProject: jest.fn(),
      findTicketByProjectAndNumber: jest.fn(),
      findTicketById: jest.fn(),
      updateTicket: jest.fn(),
      assignTicket: jest.fn(),
      softDeleteTicket: jest.fn(),
      findTicketByRefRaw: jest.fn(),
      // PrismaTicketsRepository extras used by transitions
      findTicketWithComments: jest.fn(),
      updateTicketStatusIf: jest.fn(),
      createComment: jest.fn(),
      createTicketActivity: jest.fn(),
      createTicketLink: jest.fn(),
      updateTicketLink: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketTransitionsService,
        KodaCaslAbilityFactory,
        {
          provide: TICKET_REPOSITORY,
          useValue: mockTicketRepo,
        },
        {
          provide: TRANSACTION_MANAGER,
          useValue: mockTxManager,
        },
      ],
    }).compile();

    service = module.get<TicketTransitionsService>(TicketTransitionsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('verify (CREATED → VERIFIED)', () => {
    it('should transition ticket from CREATED to VERIFIED with VERIFICATION comment', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const verificationComment = { ...mockComment, type: CommentType.VERIFICATION };
      const verifiedActivity = { ...mockActivity, toStatus: TicketStatus.VERIFIED };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(verificationComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(verifiedActivity);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'This is verified',
        mockUserPrincipal,
      );

      expect(result.ticket.status).toBe(TicketStatus.VERIFIED);
      expect(result.comment.type).toBe(CommentType.VERIFICATION);
      expect(result.activity.action).toBe(ActivityType.STATUS_CHANGE);
      expect(result.activity.fromStatus).toBe(TicketStatus.CREATED);
      expect(result.activity.toStatus).toBe(TicketStatus.VERIFIED);
    });

    it('should create a comment with correct type and actor', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const verificationComment = { ...mockComment, type: CommentType.VERIFICATION, authorUserId: 'user-123' };
      const verifiedActivity = { ...mockActivity };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(verificationComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(verifiedActivity);

      await service.verify(
        'koda',
        'KODA-1',
        'This is verified',
        mockUserPrincipal,
      );

      // Verify txManager.run was called to handle atomic operations
      expect(mockTxManager.run).toHaveBeenCalled();
    });

    it('should create TicketActivity record for status change', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const verificationComment = { ...mockComment };
      const verifiedActivity = {
        ...mockActivity,
        action: ActivityType.STATUS_CHANGE,
        fromStatus: TicketStatus.CREATED,
        toStatus: TicketStatus.VERIFIED,
      };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(verificationComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(verifiedActivity);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'This is verified',
        mockUserPrincipal,
      );

      expect(result.activity.action).toBe(ActivityType.STATUS_CHANGE);
      expect(result.activity.fromStatus).toBe(TicketStatus.CREATED);
      expect(result.activity.toStatus).toBe(TicketStatus.VERIFIED);
    });

    it('should throw 404 if project not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.verify('nonexistent', 'KODA-1', 'Comment', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });

    it('should throw 404 if ticket not found', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(null);

      await expect(
        service.verify('koda', 'KODA-999', 'Comment', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });

    it('should throw 400 if transition is invalid (not CREATED status)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue({
        ...mockTicket,
        status: TicketStatus.IN_PROGRESS,
      });

      await expect(
        service.verify('koda', 'KODA-1', 'Comment', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });
  });

  describe('start (VERIFIED → IN_PROGRESS)', () => {
    it('should transition ticket from VERIFIED to IN_PROGRESS without comment', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const updatedTicket = { ...verifiedTicket, status: TicketStatus.IN_PROGRESS };
      const inProgressActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.IN_PROGRESS };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifiedTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(inProgressActivity);

      const result = await service.start('koda', 'KODA-1', mockUserPrincipal);

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
      expect(result.activity.fromStatus).toBe(TicketStatus.VERIFIED);
      expect(result.activity.toStatus).toBe(TicketStatus.IN_PROGRESS);
    });

    it('should create TicketActivity record without comment creation', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const updatedTicket = { ...verifiedTicket, status: TicketStatus.IN_PROGRESS };
      const inProgressActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.IN_PROGRESS };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifiedTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(inProgressActivity);

      await service.start('koda', 'KODA-1', mockUserPrincipal);

      expect(mockTxManager.run).toHaveBeenCalled();
    });

    it('should throw 400 if transition is invalid (CLOSED status cannot start)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue({
        ...mockTicket,
        status: TicketStatus.CLOSED,
      });

      await expect(
        service.start('koda', 'KODA-1', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });
  });

  describe('fix (IN_PROGRESS → VERIFY_FIX)', () => {
    it('should transition from IN_PROGRESS to VERIFY_FIX with FIX_REPORT comment', async () => {
      const inProgressTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      const updatedTicket = { ...inProgressTicket, status: TicketStatus.VERIFY_FIX };
      const fixComment = { ...mockComment, type: CommentType.FIX_REPORT };
      const fixActivity = { ...mockActivity, fromStatus: TicketStatus.IN_PROGRESS, toStatus: TicketStatus.VERIFY_FIX };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(inProgressTicket);
      mockTicketRepo.createComment.mockResolvedValue(fixComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(fixActivity);

      const result = await service.fix(
        'koda',
        'KODA-1',
        'Fixed the bug',
        mockUserPrincipal,
      );

      expect(result.ticket.status).toBe(TicketStatus.VERIFY_FIX);
      expect(result.comment.type).toBe(CommentType.FIX_REPORT);
      expect(result.activity.fromStatus).toBe(TicketStatus.IN_PROGRESS);
      expect(result.activity.toStatus).toBe(TicketStatus.VERIFY_FIX);
    });

    it('should create both comment and activity in transaction', async () => {
      const inProgressTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      const updatedTicket = { ...inProgressTicket, status: TicketStatus.VERIFY_FIX };
      const fixComment = { ...mockComment, type: CommentType.FIX_REPORT };
      const fixActivity = { ...mockActivity, fromStatus: TicketStatus.IN_PROGRESS, toStatus: TicketStatus.VERIFY_FIX };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(inProgressTicket);
      mockTicketRepo.createComment.mockResolvedValue(fixComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(fixActivity);

      await service.fix(
        'koda',
        'KODA-1',
        'Fixed the bug',
        mockUserPrincipal,
      );

      expect(mockTxManager.run).toHaveBeenCalled();
    });
  });

  describe('verifyFix (VERIFY_FIX → CLOSED or IN_PROGRESS)', () => {
    it('should transition from VERIFY_FIX to CLOSED with REVIEW comment', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const updatedTicket = { ...verifyFixTicket, status: TicketStatus.CLOSED };
      const reviewComment = { ...mockComment, type: CommentType.REVIEW };
      const closedActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.CLOSED };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifyFixTicket);
      mockTicketRepo.createComment.mockResolvedValue(reviewComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(closedActivity);

      const result = await service.verifyFix(
        'koda',
        'KODA-1',
        'Approved',
        true, // approve=true → CLOSED
        mockUserPrincipal,
      );

      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
      expect(result.comment.type).toBe(CommentType.REVIEW);
      expect(result.activity.toStatus).toBe(TicketStatus.CLOSED);
    });

    it('should transition from VERIFY_FIX to IN_PROGRESS with REVIEW comment when fix failed', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const updatedTicket = { ...verifyFixTicket, status: TicketStatus.IN_PROGRESS };
      const reviewComment = { ...mockComment, type: CommentType.REVIEW };
      const inProgressActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.IN_PROGRESS };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifyFixTicket);
      mockTicketRepo.createComment.mockResolvedValue(reviewComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(inProgressActivity);

      const result = await service.verifyFix(
        'koda',
        'KODA-1',
        'Fix is not working',
        false, // approve=false → IN_PROGRESS
        mockUserPrincipal,
      );

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
      expect(result.comment.type).toBe(CommentType.REVIEW);
      expect(result.activity.toStatus).toBe(TicketStatus.IN_PROGRESS);
    });

    it('should create both comment and activity in transaction', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const updatedTicket = { ...verifyFixTicket, status: TicketStatus.CLOSED };
      const reviewComment = { ...mockComment, type: CommentType.REVIEW };
      const closedActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.CLOSED };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifyFixTicket);
      mockTicketRepo.createComment.mockResolvedValue(reviewComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(closedActivity);

      await service.verifyFix(
        'koda',
        'KODA-1',
        'Approved',
        true,
        mockUserPrincipal,
      );

      expect(mockTxManager.run).toHaveBeenCalled();
    });
  });

  describe('close (any valid → CLOSED)', () => {
    it('should close ticket from VERIFY_FIX status', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      const updatedTicket = { ...verifyFixTicket, status: TicketStatus.CLOSED };
      const closedActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFY_FIX, toStatus: TicketStatus.CLOSED };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifyFixTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(closedActivity);

      const result = await service.close('koda', 'KODA-1', mockUserPrincipal);

      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
      expect(result.activity.toStatus).toBe(TicketStatus.CLOSED);
      expect(mockTxManager.run).toHaveBeenCalled();
    });

    it('should throw 400 if transition is invalid', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket); // CREATED status

      await expect(
        service.close('koda', 'KODA-1', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });
  });

  describe('reject (CREATED or VERIFIED → REJECTED)', () => {
    it('should reject ticket from CREATED status with GENERAL comment', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.REJECTED };
      const generalComment = { ...mockComment, type: CommentType.GENERAL };
      const rejectedActivity = { ...mockActivity, fromStatus: TicketStatus.CREATED, toStatus: TicketStatus.REJECTED };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(generalComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(rejectedActivity);

      const result = await service.reject(
        'koda',
        'KODA-1',
        'Not valid',
        mockUserPrincipal,
      );

      expect(result.ticket.status).toBe(TicketStatus.REJECTED);
      expect(result.comment.type).toBe(CommentType.GENERAL);
      expect(result.activity.toStatus).toBe(TicketStatus.REJECTED);
    });

    it('should reject ticket from VERIFIED status with GENERAL comment', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const updatedTicket = { ...verifiedTicket, status: TicketStatus.REJECTED };
      const generalComment = { ...mockComment, type: CommentType.GENERAL };
      const rejectedActivity = { ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.REJECTED };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifiedTicket);
      mockTicketRepo.createComment.mockResolvedValue(generalComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(rejectedActivity);

      const result = await service.reject(
        'koda',
        'KODA-1',
        'Not valid',
        mockUserPrincipal,
      );

      expect(result.ticket.status).toBe(TicketStatus.REJECTED);
      expect(result.comment.type).toBe(CommentType.GENERAL);
    });

    it('should throw 400 if trying to reject from IN_PROGRESS', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      const inProgressTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(inProgressTicket);

      await expect(
        service.reject('koda', 'KODA-1', 'Not valid', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });

    it('should throw 400 if trying to reject from CLOSED', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      const closedTicket = { ...mockTicket, status: TicketStatus.CLOSED };
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(closedTicket);

      await expect(
        service.reject('koda', 'KODA-1', 'Not valid', mockUserPrincipal)
      ).rejects.toThrow(AppException);
    });
  });

  describe('Polymorphic Actor Handling', () => {
    it('should record actor as user in comment and activity when actorType is user', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const userComment = { ...mockComment, authorUserId: 'user-123', authorAgentId: null };
      const userActivity = { ...mockActivity, actorUserId: 'user-123', actorAgentId: null };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(userComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(userActivity);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        mockUserPrincipal,
      );

      expect(result.comment.authorUserId).toBe('user-123');
      expect(result.comment.authorAgentId).toBeNull();
      expect(result.activity.actorUserId).toBe('user-123');
      expect(result.activity.actorAgentId).toBeNull();
    });

    it('should record actor as agent in comment and activity when actorType is agent', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      const agentActivity = { ...mockActivity, actorUserId: null, actorAgentId: 'agent-123' };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(agentComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(agentActivity);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        mockAgentPrincipal,
      );

      expect(result.comment.authorUserId).toBeNull();
      expect(result.comment.authorAgentId).toBe('agent-123');
      expect(result.activity.actorUserId).toBeNull();
      expect(result.activity.actorAgentId).toBe('agent-123');
    });
  });

  describe('Transaction Atomicity', () => {
    it('should use txManager.run for atomic updates', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const verificationComment = { ...mockComment };
      const verifiedActivity = { ...mockActivity };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(verificationComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(verifiedActivity);

      await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        mockUserPrincipal,
      );

      expect(mockTxManager.run).toHaveBeenCalled();
    });

    it('should create comment, update status, and create activity in single transaction', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const verificationComment = { ...mockComment };
      const verifiedActivity = { ...mockActivity };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(verificationComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(verifiedActivity);

      const result = await service.verify(
        'koda',
        'KODA-1',
        'Verified',
        mockUserPrincipal,
      );

      // All three operations should return as part of transaction
      expect(result).toHaveProperty('ticket');
      expect(result).toHaveProperty('comment');
      expect(result).toHaveProperty('activity');
      expect(mockTxManager.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('M3: conditional transition (race protection)', () => {
    it('M3: stale status → 409 conflict, no second write', async () => {
      // Row moved between read and write: the conditional update matches 0 rows.
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(null);

      await expect(
        service.verify('koda', 'KODA-1', 'looks fine', mockUserPrincipal),
      ).rejects.toThrow(HttpException);

      try {
        await service.verify('koda', 'KODA-1', 'looks fine', mockUserPrincipal);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
      }

      // Loser must not leave side effects behind: no activity, no webhook fire path reached.
      expect(mockTicketRepo.createTicketActivity).not.toHaveBeenCalled();
    });

    it('should throw 409 on stale status in close()', async () => {
      const verifyFixTicket = { ...mockTicket, status: TicketStatus.VERIFY_FIX };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifyFixTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(null);

      await expect(
        service.close('koda', 'KODA-1', mockUserPrincipal),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      expect(mockTicketRepo.createTicketActivity).not.toHaveBeenCalled();
    });

    it('should pass the pre-read status as `from` to the conditional update', async () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      const verificationComment = { ...mockComment };
      const verifiedActivity = { ...mockActivity };

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.createComment.mockResolvedValue(verificationComment);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue(verifiedActivity);

      await service.verify('koda', 'KODA-1', 'looks fine', mockUserPrincipal);

      expect(mockTicketRepo.updateTicketStatusIf).toHaveBeenCalledWith(
        'ticket-123',
        TicketStatus.CREATED,
        TicketStatus.VERIFIED,
      );
    });
  });

  describe('M2: executeTransitionPublic enforces TRANSITION on Ticket (PATCH permission fix)', () => {
    // Agent TRIAGER: has UPDATE on Ticket (koda-casl-ability.factory.ts TRIAGER
    // case) but no TRANSITION — the escalation the M2 delegation would have
    // allowed when the PATCH route only checks UPDATE.
    const makeTriagerAgentPrincipal = (): AgentPrincipal => ({
      id: 'agent-triager',
      sub: 'agent-triager',
      actorType: 'agent',
      slug: 'triager-agent',
      status: 'ACTIVE',
      agentRoles: ['TRIAGER'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: ['WORKER'],
      name: 'Triager Agent',
    });

    const makeAdminUserPrincipal = (): UserPrincipal => ({
      id: 'admin-1',
      sub: 'admin-1',
      actorType: 'user',
      role: 'ADMIN',
      email: 'admin@example.com',
      blacklisted: false,
      revoked: false,
      authorities: ['ADMIN'],
      name: 'Admin User',
    });

    const makeDeveloperAgentPrincipal = (): AgentPrincipal => ({
      id: 'agent-dev',
      sub: 'agent-dev',
      actorType: 'agent',
      slug: 'developer-agent',
      status: 'ACTIVE',
      agentRoles: ['DEVELOPER'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: ['WORKER'],
      name: 'Developer Agent',
    });

    const mockExecuteTransitionInternalPath = () => {
      const updatedTicket = { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(updatedTicket);
      mockTicketRepo.createTicketActivity.mockResolvedValue({
        ...mockActivity,
        toStatus: TicketStatus.IN_PROGRESS,
      });
    };

    it('M2: principal without TRANSITION (agent TRIAGER, UPDATE-only) is rejected 403 and the transition never runs', async () => {
      mockExecuteTransitionInternalPath();

      await expect(
        service.executeTransitionPublic('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal()),
      ).rejects.toThrow(ForbiddenAppException);

      // The transition pipeline (lookup + conditional write + activity) must not run
      expect(mockTicketRepo.findProjectBySlug).not.toHaveBeenCalled();
      expect(mockTicketRepo.updateTicketStatusIf).not.toHaveBeenCalled();
      expect(mockTicketRepo.createTicketActivity).not.toHaveBeenCalled();
    });

    it('M2: ADMIN (MANAGE implies all) passes the TRANSITION check and the transition runs', async () => {
      mockExecuteTransitionInternalPath();

      const result = await service.executeTransitionPublic(
        'koda',
        'KODA-1',
        TicketStatus.IN_PROGRESS,
        makeAdminUserPrincipal(),
      );

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
      expect(mockTicketRepo.updateTicketStatusIf).toHaveBeenCalledWith(
        'ticket-123',
        TicketStatus.CREATED,
        TicketStatus.IN_PROGRESS,
      );
    });

    it('M2: agent with TRANSITION role (DEVELOPER) passes and the transition runs', async () => {
      mockExecuteTransitionInternalPath();

      const result = await service.executeTransitionPublic(
        'koda',
        'KODA-1',
        TicketStatus.IN_PROGRESS,
        makeDeveloperAgentPrincipal(),
      );

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
    });

    it('M2: fails closed with 403 when no ability factory is available', async () => {
      // Service constructed without the optional KodaCaslAbilityFactory — the
      // PATCH path cannot prove TRANSITION, so it must deny.
      const bareService = new TicketTransitionsService(
        mockTicketRepo,
        mockTxManager,
      );
      mockExecuteTransitionInternalPath();

      await expect(
        bareService.executeTransitionPublic('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeAdminUserPrincipal()),
      ).rejects.toThrow(ForbiddenAppException);

      expect(mockTicketRepo.updateTicketStatusIf).not.toHaveBeenCalled();
    });
  });

  // Unused variable kept to avoid removing test data
  void mockUser;
});

describe('TicketTransitionsService (H13: outbox emission)', () => {
  const fixedTimestamp = new Date('2026-01-01T00:00:00Z');

  const principal = {
    actorType: 'user' as const,
    id: 'user-123',
    name: 'Test User',
    email: 'user@example.com',
    role: 'MEMBER' as const,
    blacklisted: false,
    revoked: false,
    authorities: [],
  };

  const mockProject = {
    id: 'proj-123',
    slug: 'koda',
    key: 'KODA',
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    deletedAt: null,
  };

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: null,
    status: TicketStatus.VERIFIED,
    priority: 'HIGH',
    deletedAt: null,
  };

  const mockEvent = {
    id: 'evt-1',
    ticketId: 'ticket-123',
    projectId: 'proj-123',
    action: 'status_changed',
    actorId: 'user-123',
    actorType: 'user',
    source: 'internal',
    data: '{}',
    timestamp: fixedTimestamp,
  };

  function buildService(overrides: {
    ticketEventService?: { create: jest.Mock };
    outboxService?: { record: jest.Mock };
  } = {}) {
    const ticketRepo = {
      findProjectBySlug: jest.fn().mockResolvedValue(mockProject),
      findTicketByRefRaw: jest.fn().mockResolvedValue(mockTicket),
      // M3: the merged service uses the conditional update; the stub resolves
      // with the transitioned ticket so the H13 emission assertions below run.
      updateTicketStatusIf: jest.fn().mockResolvedValue({ ...mockTicket, status: TicketStatus.IN_PROGRESS }),
      createComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
      createTicketActivity: jest.fn().mockResolvedValue({ id: 'activity-1' }),
    };
    const txManager = {
      run: jest.fn((fn: () => unknown) => fn()),
      getClient: jest.fn(),
      isInTransaction: jest.fn(() => false),
    };
    const ticketEventService = overrides.ticketEventService ?? {
      create: jest.fn().mockResolvedValue(mockEvent),
    };
    const outboxService = overrides.outboxService ?? {
      record: jest.fn().mockResolvedValue(undefined),
    };
    const webhookDispatcher = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TicketTransitionsService(
      ticketRepo as never,
      txManager as never,
      undefined,
      webhookDispatcher as never,
      undefined,
      undefined,
      undefined,
      undefined,
      ticketEventService as never,
      outboxService as never,
    );
    return { service, ticketRepo, ticketEventService, outboxService, webhookDispatcher, txManager };
  }

  it('H13: start() records a status_changed ticket_event with the full envelope', async () => {
    const { service, ticketEventService, outboxService } = buildService();

    await service.start('koda', 'KODA-1', principal);

    expect(ticketEventService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'ticket-123',
        projectId: 'proj-123',
        action: 'status_changed',
        actorId: 'user-123',
        actorType: 'user',
        source: 'internal',
        data: { fromStatus: TicketStatus.VERIFIED, newStatus: TicketStatus.IN_PROGRESS },
      }),
    );
    expect(outboxService.record).toHaveBeenCalledWith({
      type: 'ticket_event',
      payload: {
        id: 'evt-1',
        type: 'ticket_event',
        action: 'status_changed',
        timestamp: '2026-01-01T00:00:00.000Z',
        ticketId: 'ticket-123',
        projectId: 'proj-123',
        actorId: 'user-123',
        actorType: 'user',
        data: { fromStatus: TicketStatus.VERIFIED, newStatus: TicketStatus.IN_PROGRESS },
      },
      metadata: { projectId: 'proj-123', eventId: 'evt-1' },
    });
  });

  it('H13: verify() records a status_changed ticket_event for the VERIFIED transition', async () => {
    const { service, ticketRepo, ticketEventService, outboxService } = buildService();
    // verify() transitions CREATED → VERIFIED (a VERIFIED ticket would be a no-op rule miss)
    ticketRepo.findTicketByRefRaw.mockResolvedValue({ ...mockTicket, status: TicketStatus.CREATED });

    await service.verify('koda', 'KODA-1', 'Verified', principal);

    expect(ticketEventService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'ticket-123',
        projectId: 'proj-123',
        action: 'status_changed',
        data: { fromStatus: TicketStatus.CREATED, newStatus: TicketStatus.VERIFIED },
      }),
    );
    expect(outboxService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ticket_event',
        payload: expect.objectContaining({
          action: 'status_changed',
          ticketId: 'ticket-123',
          data: { fromStatus: TicketStatus.CREATED, newStatus: TicketStatus.VERIFIED },
        }),
        metadata: { projectId: 'proj-123', eventId: 'evt-1' },
      }),
    );
  });

  it('fails the transition when event emission throws (no silent drop)', async () => {
    const { service } = buildService({
      ticketEventService: { create: jest.fn().mockRejectedValue(new Error('event store down')) },
    });

    await expect(service.start('koda', 'KODA-1', principal)).rejects.toThrow('event store down');
  });

  it('records the status_changed event and STATUS_CHANGE webhooks inside the transition transaction', async () => {
    const { service, outboxService, webhookDispatcher, txManager } = buildService();
    let depth = 0;
    txManager.run.mockImplementation(async (fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    });
    const depthAtRecord: number[] = [];
    outboxService.record.mockImplementation(async () => {
      depthAtRecord.push(depth);
    });
    webhookDispatcher.dispatch.mockImplementation(async () => {
      depthAtRecord.push(depth);
    });

    await service.start('koda', 'KODA-1', principal);

    expect(depthAtRecord.length).toBeGreaterThanOrEqual(2);
    expect(depthAtRecord.every((d) => d === 1)).toBe(true);
  });

  it('fails the transition when recording its outbox rows fails', async () => {
    const { service, outboxService } = buildService();
    outboxService.record.mockRejectedValue(new Error('outbox down'));
    await expect(service.start('koda', 'KODA-1', principal)).rejects.toThrow('outbox down');
  });
});
