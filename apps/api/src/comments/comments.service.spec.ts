import type { Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CommentsService } from './comments.service';
import { CreateCommentDto, CommentTypeEnum } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import type { KodaAgentRole, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import type { PermissionContext } from '../permissions/permission.service';
import type { PermissionDecision } from '../permissions/permissions.types';
import { ProjectAccessService } from '../projects/project-access.service';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../events/ticket-event.service';
import { AuditRecorder } from '../audit/audit-recorder.service';

describe('CommentsService', () => {
  let service: CommentsService;

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

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: 'Users cannot login',
    status: 'CREATED',
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
    body: 'This is a comment',
    type: 'GENERAL',
    authorUserId: 'user-123',
    authorAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const _mockUser = {
    id: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    role: 'MEMBER',
    passwordHash: 'hash',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const _mockAgent = {
    id: 'agent-123',
    name: 'Test Agent',
    slug: 'test-agent',
    apiKeyHash: 'hash',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockUserPrincipal = {
    id: 'user-123',
    sub: 'user-123',
    actorType: 'user' as const,
    role: 'MEMBER' as const,
    email: 'user@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test User',
  };

  const mockAgentPrincipal = {
    id: 'agent-123',
    sub: 'agent-123',
    actorType: 'agent' as const,
    slug: 'test-agent',
    status: 'ACTIVE' as const,
    agentRoles: [] as KodaAgentRole[],
    capabilities: [] as string[],
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test Agent',
  };

  const mockUser456Principal = {
    id: 'user-456',
    sub: 'user-456',
    actorType: 'user' as const,
    role: 'MEMBER' as const,
    email: 'user456@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test User 456',
  };

  const mockAgent456Principal = {
    id: 'agent-456',
    sub: 'agent-456',
    actorType: 'agent' as const,
    slug: 'test-agent-456',
    status: 'ACTIVE' as const,
    agentRoles: [] as KodaAgentRole[],
    capabilities: [] as string[],
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test Agent 456',
  };

  const mockAdminPrincipal = {
    id: 'admin-user',
    sub: 'admin-user',
    actorType: 'user' as const,
    role: 'ADMIN' as const,
    email: 'admin@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Admin User',
  };

  // US-002: the owning ticket/project of a comment, and the membership of the
  // callers used in this file. `update`/`delete` resolve comment → ticket →
  // project before any CASL check, so the repository double answers whatever
  // resolution helper the implementation adds.
  const OWNING_PROJECT = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    deletedAt: null,
  };
  const OWNING_TICKET = {
    id: 'ticket-123',
    number: 1,
    projectId: 'proj-123',
    project: OWNING_PROJECT,
    deletedAt: null,
  };
  const OWNING_RESOLUTION = {
    ...OWNING_PROJECT,
    ticketId: 'ticket-123',
    projectId: 'proj-123',
    project: OWNING_PROJECT,
    ticket: OWNING_TICKET,
  };

  /** Users with a ProjectMember row on the comment's project. */
  const memberUserIds = new Set(['user-123', 'user-456', 'admin-user']);

  // Comment repository mock. Known methods are explicit; any resolution helper
  // US-002 adds is answered by the proxy fallback (a membership/role lookup
  // answers "no row", everything else answers with the owning ticket/project).
  const mockCommentRepo: Record<string, Mock> = new Proxy(
    {
      create: vi.fn(),
      findById: vi.fn(),
      findByTicketId: vi.fn(),
      findRecentByTicketId: vi.fn(),
      countByTicketId: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findProjectBySlug: vi.fn(),
      findTicketScoped: vi.fn(),
    } as Record<string, Mock>,
    {
      get(target: Record<string, Mock>, prop: string | symbol) {
        // Never fabricate a thenable: `await` on the double (Nest inspects
        // provider values) would otherwise hang on a fabricated `then`.
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
        if (!(prop in target)) {
          if (/member|role/i.test(prop)) {
            // Membership/role lookup: answers "no row" unless the argument is a
            // user that the membership fixtures below mark as a member.
            target[prop] = vi.fn(async (...args: unknown[]) =>
              args.some((arg) => typeof arg === 'string' && memberUserIds.has(arg)) ? 'DEVELOPER' : null
            );
          } else {
            // Ownership resolution: the comment's ticket and project.
            target[prop] = vi.fn(async () => OWNING_RESOLUTION);
          }
        }
        return target[prop];
      },
    },
  );

  /** update/delete read the comment with its ticket and project in one call. */
  function givenComment(comment: unknown): void {
    mockCommentRepo.findOwningProjectAndTicket.mockResolvedValue(
      comment ? { ...OWNING_RESOLUTION, comment } : null,
    );
  }

  // Mirrors ProjectAccessService.resolveMembership: agents and global ADMINs
  // resolve without a lookup, a member gets their raw ProjectMember.role, a
  // user without a ProjectMember row is refused.
  const defaultResolveMembership = async (_projectId: string, principal: KodaPrincipal) => {
    if (!principal || principal.actorType !== 'user') return null;
    if (principal.role === 'ADMIN') return 'ADMIN';
    if (memberUserIds.has(principal.id)) return 'DEVELOPER';
    throw new ForbiddenAppException({}, 'projects');
  };
  const mockAccessService = {
    resolveMembership: vi.fn(defaultResolveMembership),
    findMembershipRole: vi.fn(async (_projectId: string, userId: string) =>
      memberUserIds.has(userId) ? 'DEVELOPER' : null
    ),
    findProjectIdBySlug: vi.fn(async () => OWNING_PROJECT.id),
  };

  /**
   * Permissions P1 (US-005): the second constructor argument, where the CASL factory used to sit.
   * `holdKeys` answers the way `PermissionService.can` does: a held key grants, and a held `X.own`
   * key grants only the caller's own row (`not-owner` otherwise).
   */
  const mockPermissions = { can: vi.fn() };
  const ownKeyCheck = (
    principal: KodaPrincipal,
    key: string,
    held: readonly string[],
    ctx: PermissionContext,
  ): PermissionDecision => {
    if (held.includes(key)) return { allowed: true, reason: 'granted' };
    if (held.includes(`${key}.own`)) {
      const createdBy = ctx.resource?.createdBy ?? null;
      const self = principal.actorType === 'user' ? 'USER' : 'AGENT';
      const own = createdBy !== null && createdBy.type === self && createdBy.id === principal.id;
      return own ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'not-owner' };
    }
    return { allowed: false, reason: 'not-granted' };
  };
  const holdKeys = (held: readonly string[]) =>
    mockPermissions.can.mockImplementation(
      async (principal: KodaPrincipal, key: string, ctx: PermissionContext = {}) =>
        ownKeyCheck(principal, key, held, ctx),
    );
  /** A developer's keys: the author-only comment rights. */
  const DEVELOPER_COMMENT_KEYS = ['comment.update.own', 'comment.delete.own'] as const;
  /** A project admin's keys: the any-row comment rights, which `*` expands to. */
  const ADMIN_COMMENT_KEYS = ['comment.update', 'comment.delete'] as const;

  const callOrder: string[] = [];
  const mockTxManager = {
    run: vi.fn(async <T>(fn: () => Promise<T>) => {
      callOrder.push('tx:start');
      const result = await fn();
      callOrder.push('tx:end');
      return result;
    }),
  };
  // Typed parameters: a zero-arg vi.fn types mock.calls as [][] and
  // mock.calls[0][0] would not compile under ts-jest diagnostics.
  const mockTicketEventService = {
    create: vi.fn(async (_input: unknown) => {
      callOrder.push('ticketEvent');
      return { id: 'tev-1', action: 'COMMENT_ADDED', timestamp: new Date('2026-09-26T00:00:00.000Z') };
    }),
  };
  const mockOutbox = {
    record: vi.fn(async (_input: unknown) => {
      callOrder.push('outbox');
    }),
  };
  const mockAudit = {
    record: vi.fn(async () => undefined),
    audited: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };

  beforeEach(async () => {
    // Tests below override this per case; reset so order cannot matter.
    mockAccessService.resolveMembership.mockReset().mockImplementation(defaultResolveMembership);
    mockPermissions.can.mockReset();
    // The default principal is a project DEVELOPER: the author-only comment keys.
    holdKeys(DEVELOPER_COMMENT_KEYS);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: COMMENT_REPOSITORY, useValue: mockCommentRepo },
        { provide: PermissionService, useValue: mockPermissions },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
        { provide: TicketEventService, useValue: mockTicketEventService },
        { provide: AuditRecorder, useValue: mockAudit },
        { provide: NathappOutboxService, useValue: mockOutbox },
        // US-002: update/delete resolve the owning project and check membership
        // before the key check.
        { provide: ProjectAccessService, useValue: mockAccessService },
        {
          provide: PrismaProjectRepository,
          useValue: {
            findBySlug: vi.fn(async () => OWNING_PROJECT),
            findMembershipRole: vi.fn(async (_projectId: string, userId: string) =>
              memberUserIds.has(userId) ? 'DEVELOPER' : null
            ),
          },
        },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
  });

  describe('create', () => {
    it('should create a comment on a ticket by slug and ref', async () => {
      const createDto: CreateCommentDto = {
        body: 'This is a test comment',
        type: 'GENERAL',
      };

      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      const createdComment = { ...mockComment, body: 'This is a test comment' };
      mockCommentRepo.create.mockResolvedValue(createdComment);

      const result = await service.create('koda', 'KODA-1', createDto, mockUserPrincipal);

      expect(result.body).toBe('This is a test comment');
      expect(mockCommentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'This is a test comment',
          type: 'GENERAL',
          ticketId: mockTicket.id,
          authorUserId: 'user-123',
        })
      );
    });

    it('should create a comment with type stored correctly', async () => {
      const createDto: CreateCommentDto = {
        body: 'This is a verification comment',
        type: 'VERIFICATION',
      };

      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      const commentWithType = { ...mockComment, type: 'VERIFICATION' };
      mockCommentRepo.create.mockResolvedValue(commentWithType);

      const result = await service.create('koda', 'KODA-1', createDto, mockUserPrincipal);

      expect(result.type).toBe('VERIFICATION');
    });

    it('should create a comment with different types (FIX_REPORT, REVIEW, STATUS_CHANGE)', async () => {
      const types = ['FIX_REPORT', 'REVIEW', 'STATUS_CHANGE'];

      for (const commentType of types) {
        mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
        mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
        const commentWithType = { ...mockComment, type: commentType };
        mockCommentRepo.create.mockResolvedValue(commentWithType);

        const createDto: CreateCommentDto = {
          body: `This is a ${commentType} comment`,
          type: commentType as any,
        };

        const result = await service.create('koda', 'KODA-1', createDto, mockUserPrincipal);

        expect(result.type).toBe(commentType);
      }
    });

    it('should assign comment to user when created by user', async () => {
      const createDto: CreateCommentDto = {
        body: 'User comment',
        type: 'GENERAL',
      };

      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockCommentRepo.create.mockResolvedValue({
        ...mockComment,
        authorUserId: 'user-456',
      });

      const result = await service.create('koda', 'KODA-1', createDto, mockUser456Principal);

      expect(result.authorUserId).toBe('user-456');
      expect(result.authorAgentId).toBeNull();
    });

    it('should assign comment to agent when created by agent', async () => {
      const createDto: CreateCommentDto = {
        body: 'Agent comment',
        type: 'GENERAL',
      };

      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockCommentRepo.create.mockResolvedValue({
        ...mockComment,
        authorUserId: null,
        authorAgentId: 'agent-456',
      });

      const result = await service.create('koda', 'KODA-1', createDto, mockAgent456Principal);

      expect(result.authorAgentId).toBe('agent-456');
      expect(result.authorUserId).toBeNull();
    });

    it('should return 404 if project not found', async () => {
      const createDto: CreateCommentDto = {
        body: 'Test comment',
        type: 'GENERAL',
      };

      mockCommentRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.create('nonexistent', 'KODA-1', createDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      const createDto: CreateCommentDto = {
        body: 'Test comment',
        type: 'GENERAL',
      };

      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(null);

      await expect(
        service.create('koda', 'KODA-999', createDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should validate required fields', async () => {
      const invalidDtos = [
        { type: 'GENERAL' }, // Missing body
        { body: '' }, // Empty body
      ];

      for (const invalidDto of invalidDtos) {
        mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
        mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);

        await expect(
          service.create('koda', 'KODA-1', invalidDto as CreateCommentDto, mockUserPrincipal)
        ).rejects.toThrow();
      }
    });
  });

  describe('create — COMMENT_ADDED ticket event', () => {
    beforeEach(() => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockCommentRepo.create.mockImplementation(async () => {
        callOrder.push('comment');
        return mockComment;
      });
    });

    it('writes the comment, the TicketEvent and the outbox row inside one transaction', async () => {
      await service.create('koda', 'KODA-1', { body: 'hello', type: 'GENERAL' }, mockUserPrincipal);

      expect(callOrder).toEqual(['tx:start', 'comment', 'ticketEvent', 'outbox', 'tx:end']);
    });

    it('records COMMENT_ADDED with only the comment id as data', async () => {
      await service.create('koda', 'KODA-1', { body: 'secret body', type: 'GENERAL' }, mockUserPrincipal);

      expect(mockTicketEventService.create).toHaveBeenCalledWith({
        ticketId: mockTicket.id,
        projectId: mockProject.id,
        action: 'COMMENT_ADDED',
        actorId: mockUserPrincipal.id,
        actorType: 'user',
        source: 'internal',
        data: { commentId: mockComment.id },
      });
      const recorded = mockOutbox.record.mock.calls[0][0] as { type: string; payload: Record<string, unknown>; metadata: Record<string, unknown> };
      expect(recorded.type).toBe('ticket_event');
      expect(recorded.payload).toEqual(expect.objectContaining({
        id: 'tev-1',
        type: 'ticket_event',
        action: 'COMMENT_ADDED',
        ticketId: mockTicket.id,
        projectId: mockProject.id,
        data: { commentId: mockComment.id },
      }));
      expect(JSON.stringify(recorded.payload)).not.toContain('secret body');
      expect(recorded.metadata).toEqual({ projectId: mockProject.id, eventId: 'tev-1' });
    });

    it('marks agent authors as actorType agent', async () => {
      await service.create('koda', 'KODA-1', { body: 'hi', type: 'GENERAL' }, mockAgentPrincipal);

      expect(mockTicketEventService.create).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'agent-123', actorType: 'agent' }));
    });

    it('propagates an event-write failure so the transaction rolls back', async () => {
      mockTicketEventService.create.mockRejectedValueOnce(new Error('db down'));

      await expect(service.create('koda', 'KODA-1', { body: 'hi', type: 'GENERAL' }, mockUserPrincipal)).rejects.toThrow('db down');
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('does not open a transaction when validation fails', async () => {
      await expect(service.create('koda', 'KODA-1', { body: '   ', type: 'GENERAL' }, mockUserPrincipal)).rejects.toBeDefined();
      expect(mockTxManager.run).not.toHaveBeenCalled();
    });
  });

  describe('findByTicket', () => {
    it('should list all comments for a ticket', async () => {
      const comments = [
        mockComment,
        { ...mockComment, id: 'comment-124', body: 'Second comment' },
      ];

      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockCommentRepo.findByTicketId.mockResolvedValue(comments);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockComment);
      expect(result[1].body).toBe('Second comment');
    });

    it('should return empty array when no comments found', async () => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockCommentRepo.findByTicketId.mockResolvedValue([]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toEqual([]);
    });

    it('should return 404 if project not found', async () => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.findByTicket('nonexistent', 'KODA-1')).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(null);

      await expect(service.findByTicket('koda', 'KODA-999')).rejects.toThrow();
    });
  });

  // S5b US-003 fix F1: the koda tool reads a ticket's newest comments through a
  // bounded query instead of loading the whole history.
  describe('findRecentByTicket', () => {
    it('asks the repository for only the newest `limit` comments and never for the whole history', async () => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      const recent = Array.from({ length: 10 }, (_, index) => ({
        ...mockComment,
        id: `comment-${index + 3}`,
        body: `body ${index + 3}`,
      }));
      mockCommentRepo.findRecentByTicketId.mockResolvedValue(recent);
      mockCommentRepo.countByTicketId.mockResolvedValue(12);

      const result = await service.findRecentByTicket('koda', 'KODA-1', 10);

      expect(mockCommentRepo.findRecentByTicketId).toHaveBeenCalledWith(mockTicket.id, 10);
      expect(mockCommentRepo.findByTicketId).not.toHaveBeenCalled();
      expect(result.total).toBe(12);
      expect(result.comments.map((comment) => comment.body)).toEqual(recent.map((comment) => comment.body));
    });

    it('returns 404 for a ref of another project and reads no comments', async () => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(null);

      await expect(service.findRecentByTicket('koda', 'OTHER-1', 10)).rejects.toThrow();
      expect(mockCommentRepo.findRecentByTicketId).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('runs the repository update inside one audited callback', async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'changed' });
      const steps: string[] = [];
      mockAudit.audited.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
        steps.push('audited:start');
        const result = await fn();
        steps.push('audited:end');
        return result;
      });
      mockCommentRepo.update.mockImplementationOnce(async () => {
        steps.push('repository:update');
        return { ...mockComment, body: 'changed' };
      });

      await service.update('comment-123', { body: 'changed' }, mockUserPrincipal);

      expect(mockAudit.audited).toHaveBeenCalledTimes(1);
      expect(steps).toEqual(['audited:start', 'repository:update', 'audited:end']);
      const entriesOf = mockAudit.audited.mock.calls[0]?.[1];
      expect(entriesOf).toEqual(expect.any(Function));
      expect(entriesOf?.({ id: 'comment-123' })).toMatchObject({
        key: 'comment.update', resourceType: 'comment', resourceId: 'comment-123',
        projectId: 'proj-123', summary: 'edited',
      });
    });

    it('should allow author (user) to edit own comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated comment body',
      };

      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({
        ...mockComment,
        body: 'Updated comment body',
      });

      const result = await service.update('comment-123', updateDto, mockUserPrincipal);

      expect(result.body).toBe('Updated comment body');
      expect(mockCommentRepo.update).toHaveBeenCalledWith('comment-123', { body: 'Updated comment body' });
    });

    it('should allow author (agent) to edit own comment', async () => {
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      const updateDto: UpdateCommentDto = {
        body: 'Updated by agent',
      };

      givenComment(agentComment);
      mockCommentRepo.update.mockResolvedValue({
        ...agentComment,
        body: 'Updated by agent',
      });

      const result = await service.update('comment-123', updateDto, mockAgentPrincipal);

      expect(result.body).toBe('Updated by agent');
    });

    it('should return 403 when non-author user tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      holdKeys([]);
      givenComment(mockComment);

      await expect(
        service.update('comment-123', updateDto, mockUser456Principal)
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      holdKeys([]);
      givenComment(mockComment);

      await expect(
        service.update('comment-123', updateDto, mockAgent456Principal)
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to edit any comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Admin edited',
      };

      holdKeys(ADMIN_COMMENT_KEYS);
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({
        ...mockComment,
        body: 'Admin edited',
      });

      const result = await service.update(
        'comment-123',
        updateDto,
        mockAdminPrincipal
      );

      expect(result.body).toBe('Admin edited');
    });

    it('should return 404 if comment not found', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body',
      };

      givenComment(null);

      await expect(
        service.update('nonexistent-123', updateDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should preserve comment type when updating body', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body only',
      };

      const verificationComment = { ...mockComment, type: 'VERIFICATION' };
      givenComment(verificationComment);
      mockCommentRepo.update.mockResolvedValue({
        ...verificationComment,
        body: 'Updated body only',
      });

      const result = await service.update('comment-123', updateDto, mockUserPrincipal);

      expect(result.type).toBe('VERIFICATION');
      expect(result.body).toBe('Updated body only');
    });

    it('should update updatedAt timestamp when editing', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated',
      };

      const now = new Date();
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({
        ...mockComment,
        body: 'Updated',
        updatedAt: now,
      });

      const result = await service.update('comment-123', updateDto, mockUserPrincipal);

      expect(result.updatedAt).toEqual(now);
    });

    it('#145: reads the comment once (no separate findById)', async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'x' });

      await service.update('comment-123', { body: 'x' }, mockUserPrincipal);

      expect(mockCommentRepo.findOwningProjectAndTicket).toHaveBeenCalledTimes(1);
      expect(mockCommentRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should allow author (user) to delete own comment', async () => {
      givenComment(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockUserPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalledWith('comment-123');
    });

    it('should allow author (agent) to delete own comment', async () => {
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      givenComment(agentComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockAgentPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalled();
    });

    it('should return 403 when non-author user tries to delete comment', async () => {
      holdKeys([]);
      givenComment(mockComment);

      await expect(
        service.delete('comment-123', mockUser456Principal)
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to delete comment', async () => {
      holdKeys([]);
      givenComment(mockComment);

      await expect(
        service.delete('comment-123', mockAgent456Principal)
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to delete any comment', async () => {
      holdKeys(ADMIN_COMMENT_KEYS);
      givenComment(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockAdminPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalledWith('comment-123');
    });

    it('should return 404 if comment not found', async () => {
      givenComment(null);

      await expect(
        service.delete('nonexistent-123', mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should not allow MEMBER users to delete others\' comments', async () => {
      holdKeys([]);
      givenComment(mockComment);

      await expect(
        service.delete('comment-123', mockUser456Principal)
      ).rejects.toThrow();
    });

    it('#145: reads the comment once (no separate findById)', async () => {
      givenComment(mockComment);

      await service.delete('comment-123', mockUserPrincipal);

      expect(mockCommentRepo.findOwningProjectAndTicket).toHaveBeenCalledTimes(1);
      expect(mockCommentRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should find comment by id', async () => {
      mockCommentRepo.findById.mockResolvedValue(mockComment);

      const result = await service.findById('comment-123');

      expect(result).toEqual(mockComment);
      expect(mockCommentRepo.findById).toHaveBeenCalledWith('comment-123');
    });

    it('should return null if comment not found', async () => {
      mockCommentRepo.findById.mockResolvedValue(null);

      const result = await service.findById('nonexistent-123');

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // US-002 — slug-less comment mutations are resolved to a project and gated by
  // membership before any CASL check.
  // ---------------------------------------------------------------------------

  describe('US-002 project membership gate', () => {
    const outsiderPrincipal = {
      id: 'user-outsider',
      sub: 'user-outsider',
      actorType: 'user' as const,
      role: 'MEMBER' as const,
      email: 'outsider@example.com',
      blacklisted: false,
      revoked: false,
      authorities: [] as string[],
      name: 'Outsider User',
    };

    it('AC1: throws NotFoundAppException for a comment whose ticket belongs to a project the user is not a member of', async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'hijacked' });

      await expect(
        service.update('comment-123', { body: 'hijacked' }, outsiderPrincipal)
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it("AC1: does not call the comment repository's update for a non-member", async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'hijacked' });

      await expect(
        service.update('comment-123', { body: 'hijacked' }, outsiderPrincipal)
      ).rejects.toBeInstanceOf(NotFoundAppException);

      expect(mockCommentRepo.update).not.toHaveBeenCalled();
    });

    it('AC1: refuses a non-member before asking for any key', async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'hijacked' });

      await expect(
        service.update('comment-123', { body: 'hijacked' }, outsiderPrincipal)
      ).rejects.toBeInstanceOf(NotFoundAppException);

      expect(mockPermissions.can).not.toHaveBeenCalled();
    });

    it('AC1 boundary: a member user passes comment.update for its own comment and reaches the repository update', async () => {
      givenComment(mockComment);
      mockCommentRepo.update.mockResolvedValue({ ...mockComment, body: 'member edit' });

      const result = await service.update('comment-123', { body: 'member edit' }, mockUserPrincipal);

      expect(result.body).toBe('member edit');
      // US-005: the key, the resolved project and the row's author are all passed
      // to `PermissionService.can`, which is what makes `comment.update.own` decide.
      expect(mockPermissions.can).toHaveBeenCalledWith(mockUserPrincipal, 'comment.update', {
        projectId: OWNING_PROJECT.id,
        resource: { createdBy: { type: 'USER', id: 'user-123' } },
      });
      expect(mockCommentRepo.update).toHaveBeenCalledWith('comment-123', { body: 'member edit' });
    });

    it('AC2: throws NotFoundAppException for a comment in a project the user is not a member of', async () => {
      givenComment(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await expect(service.delete('comment-123', outsiderPrincipal)).rejects.toBeInstanceOf(
        NotFoundAppException
      );

      expect(mockCommentRepo.delete).not.toHaveBeenCalled();
    });

    it('AC2 boundary: a member user deletes through the repository', async () => {
      givenComment(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockUserPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalledWith('comment-123');
    });

    it('AC3: an agent principal is decided by the key check without a membership lookup', async () => {
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      givenComment(agentComment);
      mockCommentRepo.update.mockResolvedValue({ ...agentComment, body: 'agent edit' });

      const result = await service.update('comment-123', { body: 'agent edit' }, mockAgentPrincipal);

      expect(result.body).toBe('agent edit');
      expect(mockPermissions.can).toHaveBeenCalledWith(mockAgentPrincipal, 'comment.update', {
        projectId: OWNING_PROJECT.id,
        resource: { createdBy: { type: 'AGENT', id: 'agent-123' } },
      });
      // Agents are cross-project: no ProjectMember row may be looked up.
      expect(mockAccessService.findMembershipRole).not.toHaveBeenCalled();
      expect(mockCommentRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('AC5 boundary: a global ADMIN who is not a member deletes without a membership row', async () => {
      holdKeys(ADMIN_COMMENT_KEYS);
      givenComment(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockAdminPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalledWith('comment-123');
    });
  });

  // ---------------------------------------------------------------------------
  // US-005 — update/delete ask `comment.update` / `comment.delete` about the
  // comment's author, so a caller holding only the `.own` key is refused on
  // someone else's comment, and a non-member still sees 404 so the comment's
  // existence stays hidden.
  // ---------------------------------------------------------------------------

  describe('US-005 comment key checks on the row', () => {
    const ownership = {
      project: { id: 'p1', slug: 'koda', key: 'KODA', deletedAt: null },
      ticket: { id: 't1', deletedAt: null },
    };
    const othersComment = {
      id: 'c1',
      ticketId: 't1',
      body: 'b',
      type: 'GENERAL',
      authorUserId: 'someone-else',
      authorAgentId: null,
    };

    beforeEach(() => {
      mockCommentRepo.findOwningProjectAndTicket.mockResolvedValue({ ...ownership, comment: othersComment });
    });

    it('asks for comment.delete with the comment\'s project and author', async () => {
      holdKeys(ADMIN_COMMENT_KEYS);

      await service.delete('c1', mockUserPrincipal);

      expect(mockPermissions.can).toHaveBeenCalledWith(mockUserPrincipal, 'comment.delete', {
        projectId: 'p1',
        resource: { createdBy: { type: 'USER', id: 'someone-else' } },
      });
      expect(mockCommentRepo.delete).toHaveBeenCalledWith('c1');
    });

    it("a caller holding the any-row key may delete another user's comment", async () => {
      holdKeys(ADMIN_COMMENT_KEYS);
      await expect(service.delete('c1', mockUserPrincipal)).resolves.toBeUndefined();
      expect(mockCommentRepo.delete).toHaveBeenCalledWith('c1');
    });

    it("a caller holding only comment.delete.own may not delete another user's comment", async () => {
      holdKeys(DEVELOPER_COMMENT_KEYS);
      await expect(service.delete('c1', mockUserPrincipal)).rejects.toBeInstanceOf(
        ForbiddenAppException
      );
      expect(mockCommentRepo.delete).not.toHaveBeenCalled();
    });

    it('a refusal is 403 with the permissions error code, not the comments one', async () => {
      holdKeys(DEVELOPER_COMMENT_KEYS);

      const error = await service.update('c1', { body: 'x' }, mockUserPrincipal).catch((e: unknown) => e);
      expect((error as ForbiddenAppException).prefix).toBe('permissions');
      expect(mockCommentRepo.update).not.toHaveBeenCalled();
    });

    it("a caller holding only comment.update.own may not edit another user's comment", async () => {
      holdKeys(DEVELOPER_COMMENT_KEYS);
      await expect(
        service.update('c1', { body: 'x' }, mockUserPrincipal)
      ).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(mockCommentRepo.update).not.toHaveBeenCalled();
    });

    it("a caller holding comment.update may edit another user's comment", async () => {
      holdKeys(ADMIN_COMMENT_KEYS);
      mockCommentRepo.update.mockResolvedValue({ ...othersComment, body: 'x' });

      await expect(service.update('c1', { body: 'x' }, mockUserPrincipal)).resolves.toEqual(
        expect.objectContaining({ body: 'x' })
      );
    });

    it('a comment with no author is never the caller\'s own row', async () => {
      holdKeys(DEVELOPER_COMMENT_KEYS);
      mockCommentRepo.findOwningProjectAndTicket.mockResolvedValue({
        ...ownership,
        comment: { ...othersComment, authorUserId: null, authorAgentId: null },
      });

      await expect(service.delete('c1', mockUserPrincipal)).rejects.toBeInstanceOf(
        ForbiddenAppException
      );
      expect(mockPermissions.can).toHaveBeenCalledWith(mockUserPrincipal, 'comment.delete', {
        projectId: 'p1',
        resource: { createdBy: null },
      });
    });

    it('a non-member still gets 404, not 403', async () => {
      mockAccessService.resolveMembership.mockRejectedValue(
        new ForbiddenAppException({}, 'projects')
      );
      await expect(service.delete('c1', mockUserPrincipal)).rejects.toBeInstanceOf(
        NotFoundAppException
      );
    });
  });
});
