import type { Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus, CommentType, ActivityType } from '../../common/enums';
import { TicketTransitionsService } from './ticket-transitions.service';
import { AppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { TicketEventService } from '../../events/ticket-event.service';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TICKET_REPOSITORY } from '../domain/ticket.domain';
import { PermissionService } from '../../permissions/permission.service';
import type { AgentPrincipal, KodaPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';

vi.mock('../../vcs/factory', () => ({ createVcsProvider: vi.fn() }));
vi.mock('../../common/utils/encryption.util', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-token'),
}));

import { createVcsProvider } from '../../vcs/factory';

describe('TicketTransitionsService', () => {
  let service: TicketTransitionsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTxManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTicketRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTicketEventService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOutbox: any;
  /** The edge check's decision point: allowed by default, per-test refusals below. */
  let mockPermissions: { can: Mock };

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
      run: vi.fn((fn: () => unknown) => fn()),
      getClient: vi.fn(),
      isInTransaction: vi.fn(() => false),
    };

    mockTicketRepo = {
      findProjectBySlug: vi.fn(),
      findLastTicketInProject: vi.fn(),
      createTicket: vi.fn(),
      findTicketByProjectAndNumber: vi.fn(),
      findTicketById: vi.fn(),
      updateTicket: vi.fn(),
      assignTicket: vi.fn(),
      softDeleteTicket: vi.fn(),
      findTicketByRefRaw: vi.fn(),
      // PrismaTicketsRepository extras used by transitions
      findTicketWithComments: vi.fn(),
      updateTicketStatusIf: vi.fn(),
      createComment: vi.fn(),
      createTicketActivity: vi.fn(),
      createTicketLink: vi.fn(),
      updateTicketLink: vi.fn(),
    };

    mockTicketEventService = { create: vi.fn().mockResolvedValue({ id: 'ev-1', createdAt: new Date() }) };
    mockOutbox = { record: vi.fn().mockResolvedValue(undefined) };
    mockPermissions = { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketTransitionsService,
        {
          provide: TICKET_REPOSITORY,
          useValue: mockTicketRepo,
        },
        {
          provide: TRANSACTION_MANAGER,
          useValue: mockTxManager,
        },
        {
          provide: PermissionService,
          useValue: mockPermissions,
        },
        {
          provide: TicketEventService,
          useValue: mockTicketEventService,
        },
        {
          provide: NathappOutboxService,
          useValue: mockOutbox,
        },
      ],
    }).compile();

    service = module.get<TicketTransitionsService>(TicketTransitionsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
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

  describe('startForDispatch (Permissions P1d US-003: the dispatch-only start)', () => {
    it('moves a VERIFIED ticket to IN_PROGRESS without asking for the edge key', async () => {
      const verifiedTicket = { ...mockTicket, status: TicketStatus.VERIFIED };
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(verifiedTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue({ ...verifiedTicket, status: TicketStatus.IN_PROGRESS });
      mockTicketRepo.createTicketActivity.mockResolvedValue({
        ...mockActivity, fromStatus: TicketStatus.VERIFIED, toStatus: TicketStatus.IN_PROGRESS,
      });

      const result = await service.startForDispatch('koda', 'KODA-1', mockUserPrincipal);

      expect(result.ticket.status).toBe(TicketStatus.IN_PROGRESS);
      // The dispatcher was authorized for `fleet.job.dispatch`, not for the ticket's edge key.
      expect(mockPermissions.can).not.toHaveBeenCalled();
      // Everything else is `start`: the conditional write and the activity row with the caller as actor.
      expect(mockTicketRepo.updateTicketStatusIf).toHaveBeenCalledWith('ticket-123', TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS);
      expect(mockTicketRepo.createTicketActivity).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-123', action: ActivityType.STATUS_CHANGE, actorUserId: 'user-123' }),
      );
      // No comment: the dispatch starts the ticket silently, exactly like `start`.
      expect(mockTicketRepo.createComment).not.toHaveBeenCalled();
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

  describe('close (admin override with reason)', () => {
    const inProgress = { ...mockTicket, status: TicketStatus.IN_PROGRESS };

    beforeEach(() => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(inProgress);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue({ ...inProgress, status: TicketStatus.CLOSED });
      mockTicketRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockTicketRepo.createComment.mockResolvedValue({ ...mockComment, id: 'c-close', type: CommentType.GENERAL, body: 'duplicate of KODA-2' });
    });

    it('writes the reason as a GENERAL comment in the same transaction as the status change', async () => {
      const result = await service.close('koda', 'KODA-1', 'duplicate of KODA-2', mockUserPrincipal);
      expect(mockTxManager.run).toHaveBeenCalledTimes(1);
      expect(mockTicketRepo.createComment).toHaveBeenCalledWith(expect.objectContaining({
        ticketId: inProgress.id, body: 'duplicate of KODA-2', type: CommentType.GENERAL, authorUserId: 'user-123',
      }));
      expect(result.comment.id).toBe('c-close');
      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
    });

    it('emits COMMENT_ADDED for the reason comment, like any comment', async () => {
      await service.close('koda', 'KODA-1', 'duplicate of KODA-2', mockUserPrincipal);
      expect(mockTicketEventService.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'COMMENT_ADDED', ticketId: inProgress.id, data: { commentId: 'c-close' },
      }));
    });

    it('does not write the comment when the conditional status write returns null (lost update, 409)', async () => {
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(null);
      mockTxManager.run.mockImplementation(async (fn: () => unknown) => fn());
      await expect(service.close('koda', 'KODA-1', 'reason', mockUserPrincipal)).rejects.toMatchObject({ status: 409 });
      expect(mockTicketRepo.createComment).not.toHaveBeenCalled();
    });

    it.each([TicketStatus.CREATED, TicketStatus.CLOSED, TicketStatus.REJECTED])('refuses from %s (400)', async (status) => {
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue({ ...mockTicket, status });
      await expect(service.close('koda', 'KODA-1', 'reason', mockUserPrincipal)).rejects.toBeInstanceOf(AppException);
      expect(mockTicketRepo.createComment).not.toHaveBeenCalled();
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
        service.close('koda', 'KODA-1', 'reason', mockUserPrincipal),
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

  describe('M2: the edge key gates a transition, for every caller path', () => {
    // Agent TRIAGER: its legacy TRIAGER role holds ticket.transition.verify but not
    // ticket.transition.start — the escalation the old PATCH delegation allowed when the route
    // only proved UPDATE on Ticket.
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

    it('M2: a refused edge key is a 403 permissions and nothing is written', async () => {
      mockExecuteTransitionInternalPath();
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

      await expect(
        service.executeTransitionPublic('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);

      // The lookups run (404 precedence), the edge check refuses, and the write pipeline never starts.
      expect(mockTicketRepo.findProjectBySlug).toHaveBeenCalled();
      expect(mockTicketRepo.findTicketByRefRaw).toHaveBeenCalled();
      expect(mockTicketRepo.updateTicketStatusIf).not.toHaveBeenCalled();
      expect(mockTicketRepo.createTicketActivity).not.toHaveBeenCalled();
      expect(mockTicketRepo.createComment).not.toHaveBeenCalled();
    });

    it('M2: the edge check asks for the key of the ticket\'s current status, in the ticket\'s project', async () => {
      mockExecuteTransitionInternalPath();

      await service.executeTransitionPublic('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal());

      expect(mockPermissions.can).toHaveBeenCalledWith(
        makeTriagerAgentPrincipal(),
        'ticket.transition.start',
        { projectId: mockProject.id },
      );
    });

    it('M2: an allowed edge runs the transition', async () => {
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

    it('M2: a pair with no edge key skips the check and validateTransition answers (400)', async () => {
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);

      // CREATED -> CLOSED is not an edge: the refusal of the double must be irrelevant here.
      await expect(
        service.executeTransitionPublic('koda', 'KODA-1', TicketStatus.CLOSED, makeDeveloperAgentPrincipal()),
      ).rejects.toMatchObject({ httpStatus: 400 });
      expect(mockPermissions.can).not.toHaveBeenCalled();
      expect(mockTicketRepo.updateTicketStatusIf).not.toHaveBeenCalled();
    });

    it('M2: the transition methods check the edge too (verify on a VERIFY_FIX ticket needs the approve key)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue({ ...mockTicket, status: TicketStatus.VERIFY_FIX });
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

      await expect(service.verify('koda', 'KODA-1', 'lgtm', makeTriagerAgentPrincipal())).rejects.toBeInstanceOf(
        ForbiddenAppException,
      );

      expect(mockPermissions.can).toHaveBeenCalledWith(
        makeTriagerAgentPrincipal(),
        'ticket.transition.verify-fix.approve',
        { projectId: mockProject.id },
      );
      expect(mockTicketRepo.updateTicketStatusIf).not.toHaveBeenCalled();
    });

    it('M2: assertTransitionAllowed applies the edge check without validating the transition', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

      await expect(
        service.assertTransitionAllowed('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);

      // The edge check runs; no transition is executed.
      expect(mockPermissions.can).toHaveBeenCalledWith(
        makeTriagerAgentPrincipal(),
        'ticket.transition.start',
        { projectId: mockProject.id },
      );
      expect(mockTicketRepo.updateTicketStatusIf).not.toHaveBeenCalled();
    });

    it('M2: assertTransitionAllowed keeps 404 precedence for an unknown project or ticket', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.assertTransitionAllowed('nope', 'KODA-1', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal()),
      ).rejects.toBeInstanceOf(AppException);
      expect(mockPermissions.can).not.toHaveBeenCalled();

      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(null);

      await expect(
        service.assertTransitionAllowed('koda', 'KODA-999', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal()),
      ).rejects.toBeInstanceOf(AppException);
      expect(mockPermissions.can).not.toHaveBeenCalled();
    });

    it('M2: assertTransitionAllowed allows a pair with no edge key (CREATED -> CLOSED)', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

      await expect(
        service.assertTransitionAllowed('koda', 'KODA-1', TicketStatus.CLOSED, makeTriagerAgentPrincipal()),
      ).resolves.toBeUndefined();
      expect(mockPermissions.can).not.toHaveBeenCalled();
    });

    // Whole-branch fix B3: the PATCH's field writes run inside the transition transaction.
    it('B3: runs the field patch inside the transition transaction, after the conditional status write', async () => {
      mockExecuteTransitionInternalPath();
      const order: string[] = [];
      mockTicketRepo.updateTicketStatusIf.mockImplementation(async () => {
        order.push('status');
        return { ...mockTicket, status: TicketStatus.IN_PROGRESS };
      });
      mockTxManager.run.mockImplementation(async (fn: () => Promise<unknown>) => {
        order.push('tx:start');
        const value = await fn();
        order.push('tx:end');
        return value;
      });
      const patched = { ...mockTicket, title: 'Renamed', status: TicketStatus.IN_PROGRESS };
      const fields = vi.fn(async () => {
        order.push('fields');
        return patched;
      });

      const result = await service.executeTransitionPublic(
        'koda',
        'KODA-1',
        TicketStatus.IN_PROGRESS,
        makeAdminUserPrincipal(),
        fields,
      );

      expect(fields).toHaveBeenCalledWith({ ticketId: 'ticket-123', projectId: 'proj-123', previous: mockTicket });
      expect(order).toEqual(['tx:start', 'status', 'fields', 'tx:end']);
      // The patched row is the response body, so the PATCH reflects the fields it wrote.
      expect(result.ticket).toMatchObject({ title: 'Renamed', status: TicketStatus.IN_PROGRESS });
    });

    it('B3: a lost status race (409) never runs the field patch', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(mockTicket);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(null);
      const fields = vi.fn(async () => ({ ...mockTicket, title: 'Renamed' }));

      await expect(
        service.executeTransitionPublic('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeAdminUserPrincipal(), fields),
      ).rejects.toBeInstanceOf(HttpException);

      expect(fields).not.toHaveBeenCalled();
      expect(mockTicketRepo.createTicketActivity).not.toHaveBeenCalled();
    });

    it('B3: a refused edge key never runs the field patch', async () => {
      mockExecuteTransitionInternalPath();
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });
      const fields = vi.fn(async () => ({ ...mockTicket, title: 'Renamed' }));

      await expect(
        service.executeTransitionPublic('koda', 'KODA-1', TicketStatus.IN_PROGRESS, makeTriagerAgentPrincipal(), fields),
      ).rejects.toBeInstanceOf(ForbiddenAppException);

      expect(fields).not.toHaveBeenCalled();
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
    ticketEventService?: { create: Mock };
    outboxService?: { record: Mock };
  } = {}) {
    const ticketRepo = {
      findProjectBySlug: vi.fn().mockResolvedValue(mockProject),
      findTicketByRefRaw: vi.fn().mockResolvedValue(mockTicket),
      // M3: the merged service uses the conditional update; the stub resolves
      // with the transitioned ticket so the H13 emission assertions below run.
      updateTicketStatusIf: vi.fn().mockResolvedValue({ ...mockTicket, status: TicketStatus.IN_PROGRESS }),
      createComment: vi.fn().mockResolvedValue({ id: 'comment-1' }),
      createTicketActivity: vi.fn().mockResolvedValue({ id: 'activity-1' }),
    };
    const txManager = {
      run: vi.fn((fn: () => unknown) => fn()),
      getClient: vi.fn(),
      isInTransaction: vi.fn(() => false),
    };
    const ticketEventService = overrides.ticketEventService ?? {
      create: vi.fn().mockResolvedValue(mockEvent),
    };
    const outboxService = overrides.outboxService ?? {
      record: vi.fn().mockResolvedValue(undefined),
    };
    const webhookDispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketTransitionsService(
      ticketRepo as never,
      txManager as never,
      { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) } as never,
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
      ticketEventService: { create: vi.fn().mockRejectedValue(new Error('event store down')) },
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

describe('TicketTransitionsService (auto-PR on VERIFIED: extractLinksFromPr prNumber)', () => {
  const autoPrProject = {
    id: 'proj-123',
    slug: 'koda',
    key: 'KODA',
    deletedAt: null,
  };

  const autoPrTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: 'Users cannot login',
    status: TicketStatus.CREATED,
    priority: 'HIGH',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const autoPrPrincipal = {
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

  it('passes the created PR number as the sixth argument to extractLinksFromPr', async () => {
    const createdPr = { number: 555, url: 'https://github.com/acme/widgets/pull/555' };
    const provider = {
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      createPullRequest: vi.fn().mockResolvedValue(createdPr),
    };
    (createVcsProvider as Mock).mockReturnValue(provider);

    const connection = {
      isActive: true,
      provider: 'github',
      repoOwner: 'acme',
      repoName: 'widgets',
      encryptedToken: 'enc-token',
    };

    const ticketRepo = {
      findProjectBySlug: vi.fn().mockResolvedValue(autoPrProject),
      findTicketByRefRaw: vi.fn().mockResolvedValue(autoPrTicket),
      updateTicketStatusIf: vi.fn().mockResolvedValue({ ...autoPrTicket, status: TicketStatus.VERIFIED }),
      createComment: vi.fn().mockResolvedValue({ id: 'comment-123' }),
      createTicketActivity: vi.fn().mockResolvedValue({ id: 'activity-123' }),
      createTicketLink: vi.fn().mockResolvedValue({ id: 'link-123' }),
      hasFleetOwnership: vi.fn().mockResolvedValue(false),
      createTicketActivity2: undefined,
    };
    const txManager = { run: (fn: () => unknown) => fn() };
    const vcsConnectionService = { getFullByProject: vi.fn().mockResolvedValue(connection) };
    const vcsLinkExtractorService = { extractLinksFromPr: vi.fn().mockResolvedValue(undefined) };
    const vcsConfig = { encryptionKey: 'k'.repeat(64) };

    const svc = new TicketTransitionsService(
      ticketRepo as never,
      txManager as never,
      { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) } as never,
      undefined,
      undefined,
      vcsConnectionService as never,
      { create: vi.fn() } as never,
      vcsLinkExtractorService as never,
      vcsConfig as never,
    );

    await svc.verify('koda', 'KODA-1', 'Verified', autoPrPrincipal as never);

    expect(provider.createPullRequest).toHaveBeenCalled();
    expect(vcsLinkExtractorService.extractLinksFromPr).toHaveBeenCalledTimes(1);
    expect(vcsLinkExtractorService.extractLinksFromPr).toHaveBeenCalledWith(
      expect.objectContaining({ id: autoPrProject.id, key: autoPrProject.key }),
      expect.objectContaining({ id: autoPrTicket.id, number: autoPrTicket.number }),
      connection,
      'k'.repeat(64),
      expect.stringContaining('KODA-1'),
      555,
    );
  });

  it('skips the classic PR when fleet already owns the ticket (#231)', async () => {
    const provider = {
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      createPullRequest: vi.fn().mockResolvedValue({ number: 999, url: 'https://github.com/acme/widgets/pull/999' }),
    };
    (createVcsProvider as Mock).mockReturnValue(provider);

    const connection = {
      isActive: true,
      provider: 'github',
      repoOwner: 'acme',
      repoName: 'widgets',
      encryptedToken: 'enc-token',
    };

    const ticketRepo = {
      findProjectBySlug: vi.fn().mockResolvedValue(autoPrProject),
      findTicketByRefRaw: vi.fn().mockResolvedValue(autoPrTicket),
      updateTicketStatusIf: vi.fn().mockResolvedValue({ ...autoPrTicket, status: TicketStatus.VERIFIED }),
      createComment: vi.fn().mockResolvedValue({ id: 'comment-123' }),
      createTicketActivity: vi.fn().mockResolvedValue({ id: 'activity-123' }),
      createTicketLink: vi.fn().mockResolvedValue({ id: 'link-123' }),
      hasFleetOwnership: vi.fn().mockResolvedValue(true),
    };
    const txManager = { run: (fn: () => unknown) => fn() };
    const vcsConnectionService = { getFullByProject: vi.fn().mockResolvedValue(connection) };
    const vcsLinkExtractorService = { extractLinksFromPr: vi.fn().mockResolvedValue(undefined) };
    const vcsConfig = { encryptionKey: 'k'.repeat(64) };

    const svc = new TicketTransitionsService(
      ticketRepo as never,
      txManager as never,
      { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) } as never,
      undefined,
      undefined,
      vcsConnectionService as never,
      { create: vi.fn() } as never,
      vcsLinkExtractorService as never,
      vcsConfig as never,
    );

    await svc.verify('koda', 'KODA-1', 'Verified', autoPrPrincipal as never);

    expect(ticketRepo.hasFleetOwnership).toHaveBeenCalledWith(autoPrTicket.id);
    expect(vcsConnectionService.getFullByProject).not.toHaveBeenCalled();
    expect(provider.createPullRequest).not.toHaveBeenCalled();
    expect(ticketRepo.createTicketLink).not.toHaveBeenCalled();
  });
});
