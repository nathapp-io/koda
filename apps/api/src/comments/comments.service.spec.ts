import { Test, TestingModule } from '@nestjs/testing';
import { CommentsService } from './comments.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { CreateCommentDto, CommentTypeEnum } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
import type { KodaAgentRole } from '../auth/principal/koda-principal.types';

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

  // PrismaService mock is only needed for project/ticket lookups
  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
      ticket: {
        findUnique: jest.fn(),
      },
    },
  };

  // Comment repository mock
  const mockCommentRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findByTicketId: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  let mockCaslCan: jest.Mock;

  beforeEach(async () => {
    mockCaslCan = jest.fn().mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: COMMENT_REPOSITORY, useValue: mockCommentRepo },
        { provide: KodaCaslAbilityFactory, useValue: { createForUser: jest.fn().mockResolvedValue({ can: mockCaslCan }) } },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a comment on a ticket by slug and ref', async () => {
      const createDto: CreateCommentDto = {
        body: 'This is a test comment',
        type: 'GENERAL',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      const commentWithType = { ...mockComment, type: 'VERIFICATION' };
      mockCommentRepo.create.mockResolvedValue(commentWithType);

      const result = await service.create('koda', 'KODA-1', createDto, mockUserPrincipal);

      expect(result.type).toBe('VERIFICATION');
    });

    it('should create a comment with different types (FIX_REPORT, REVIEW, STATUS_CHANGE)', async () => {
      const types = ['FIX_REPORT', 'REVIEW', 'STATUS_CHANGE'];

      for (const commentType of types) {
        mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
        mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(
        service.create('nonexistent', 'KODA-1', createDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      const createDto: CreateCommentDto = {
        body: 'Test comment',
        type: 'GENERAL',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.create('koda', 'KODA-999', createDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should validate required fields', async () => {
      const invalidDtos = [
        { type: 'GENERAL' }, // Missing body
        { body: '' }, // Empty body
        { body: 'Test comment' }, // Missing type
      ];

      for (const invalidDto of invalidDtos) {
        mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
        mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);

        await expect(
          service.create('koda', 'KODA-1', invalidDto as CreateCommentDto, mockUserPrincipal)
        ).rejects.toThrow();
      }
    });
  });

  describe('findByTicket', () => {
    it('should list all comments for a ticket', async () => {
      const comments = [
        mockComment,
        { ...mockComment, id: 'comment-124', body: 'Second comment' },
      ];

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockCommentRepo.findByTicketId.mockResolvedValue(comments);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockComment);
      expect(result[1].body).toBe('Second comment');
    });

    it('should return empty array when no comments found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockCommentRepo.findByTicketId.mockResolvedValue([]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toEqual([]);
    });

    it('should return 404 if project not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.findByTicket('nonexistent', 'KODA-1')).rejects.toThrow();
    });

    it('should return 404 if ticket not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(null);

      await expect(service.findByTicket('koda', 'KODA-999')).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should allow author (user) to edit own comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated comment body',
      };

      mockCommentRepo.findById.mockResolvedValue(mockComment);
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

      mockCommentRepo.findById.mockResolvedValue(agentComment);
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

      mockCaslCan.mockReturnValue(false);
      mockCommentRepo.findById.mockResolvedValue(mockComment);

      await expect(
        service.update('comment-123', updateDto, mockUser456Principal)
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      mockCaslCan.mockReturnValue(false);
      mockCommentRepo.findById.mockResolvedValue(mockComment);

      await expect(
        service.update('comment-123', updateDto, mockAgent456Principal)
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to edit any comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Admin edited',
      };

      mockCommentRepo.findById.mockResolvedValue(mockComment);
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

      mockCommentRepo.findById.mockResolvedValue(null);

      await expect(
        service.update('nonexistent-123', updateDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should preserve comment type when updating body', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body only',
      };

      const verificationComment = { ...mockComment, type: 'VERIFICATION' };
      mockCommentRepo.findById.mockResolvedValue(verificationComment);
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
      mockCommentRepo.findById.mockResolvedValue(mockComment);
      mockCommentRepo.update.mockResolvedValue({
        ...mockComment,
        body: 'Updated',
        updatedAt: now,
      });

      const result = await service.update('comment-123', updateDto, mockUserPrincipal);

      expect(result.updatedAt).toEqual(now);
    });
  });

  describe('delete', () => {
    it('should allow author (user) to delete own comment', async () => {
      mockCommentRepo.findById.mockResolvedValue(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockUserPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalledWith('comment-123');
    });

    it('should allow author (agent) to delete own comment', async () => {
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      mockCommentRepo.findById.mockResolvedValue(agentComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockAgentPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalled();
    });

    it('should return 403 when non-author user tries to delete comment', async () => {
      mockCaslCan.mockReturnValue(false);
      mockCommentRepo.findById.mockResolvedValue(mockComment);

      await expect(
        service.delete('comment-123', mockUser456Principal)
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to delete comment', async () => {
      mockCaslCan.mockReturnValue(false);
      mockCommentRepo.findById.mockResolvedValue(mockComment);

      await expect(
        service.delete('comment-123', mockAgent456Principal)
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to delete any comment', async () => {
      mockCommentRepo.findById.mockResolvedValue(mockComment);
      mockCommentRepo.delete.mockResolvedValue(undefined);

      await service.delete('comment-123', mockAdminPrincipal);

      expect(mockCommentRepo.delete).toHaveBeenCalledWith('comment-123');
    });

    it('should return 404 if comment not found', async () => {
      mockCommentRepo.findById.mockResolvedValue(null);

      await expect(
        service.delete('nonexistent-123', mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should not allow MEMBER users to delete others\' comments', async () => {
      mockCaslCan.mockReturnValue(false);
      mockCommentRepo.findById.mockResolvedValue(mockComment);

      await expect(
        service.delete('comment-123', mockUser456Principal)
      ).rejects.toThrow();
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
});
