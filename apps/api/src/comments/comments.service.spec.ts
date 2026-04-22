import { Test, TestingModule } from '@nestjs/testing';
import { CommentsService } from './comments.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { CreateCommentDto, CommentTypeEnum } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

describe('CommentsService', () => {
  let service: CommentsService;
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

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
      ticket: {
        findUnique: jest.fn(),
      },
      comment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);
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
      mockPrismaService.client.comment.create.mockResolvedValue(createdComment);

      const result = await service.create('koda', 'KODA-1', createDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result.body).toBe('This is a test comment');
      expect(prismaService.client.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            body: 'This is a test comment',
            type: 'GENERAL',
            ticketId: mockTicket.id,
            authorUserId: 'user-123',
          }),
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
      mockPrismaService.client.comment.create.mockResolvedValue(commentWithType);

      const result = await service.create('koda', 'KODA-1', createDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result.type).toBe('VERIFICATION');
    });

    it('should create a comment with different types (FIX_REPORT, REVIEW, STATUS_CHANGE)', async () => {
      const types = ['FIX_REPORT', 'REVIEW', 'STATUS_CHANGE'];

      for (const commentType of types) {
        mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
        mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
        const commentWithType = { ...mockComment, type: commentType };
        mockPrismaService.client.comment.create.mockResolvedValue(commentWithType);

        const createDto: CreateCommentDto = {
          body: `This is a ${commentType} comment`,
          type: commentType as any,
        };

        const result = await service.create('koda', 'KODA-1', createDto, { id: 'user-123', sub: 'user-123' }, 'user');

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
      mockPrismaService.client.comment.create.mockResolvedValue({
        ...mockComment,
        authorUserId: 'user-456',
      });

      const result = await service.create('koda', 'KODA-1', createDto, { id: 'user-456', sub: 'user-456' }, 'user');

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
      mockPrismaService.client.comment.create.mockResolvedValue({
        ...mockComment,
        authorUserId: null,
        authorAgentId: 'agent-456',
      });

      const result = await service.create('koda', 'KODA-1', createDto, { id: 'agent-456', sub: 'agent-456' }, 'agent');

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
        service.create('nonexistent', 'KODA-1', createDto, { id: 'user-123', sub: 'user-123' }, 'user')
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
        service.create('koda', 'KODA-999', createDto, { id: 'user-123', sub: 'user-123' }, 'user')
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
          service.create('koda', 'KODA-1', invalidDto as CreateCommentDto, { id: 'user-123', sub: 'user-123' }, 'user')
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
      mockPrismaService.client.comment.findMany.mockResolvedValue(comments);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockComment);
      expect(result[1].body).toBe('Second comment');
    });

    it('should return empty array when no comments found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.comment.findMany.mockResolvedValue([]);

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

      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);
      mockPrismaService.client.comment.update.mockResolvedValue({
        ...mockComment,
        body: 'Updated comment body',
      });

      const result = await service.update('comment-123', updateDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result.body).toBe('Updated comment body');
      expect(prismaService.client.comment.update).toHaveBeenCalledWith({
        where: { id: 'comment-123' },
        data: { body: 'Updated comment body' },
      });
    });

    it('should allow author (agent) to edit own comment', async () => {
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      const updateDto: UpdateCommentDto = {
        body: 'Updated by agent',
      };

      mockPrismaService.client.comment.findUnique.mockResolvedValue(agentComment);
      mockPrismaService.client.comment.update.mockResolvedValue({
        ...agentComment,
        body: 'Updated by agent',
      });

      const result = await service.update('comment-123', updateDto, { id: 'agent-123', sub: 'agent-123' }, 'agent');

      expect(result.body).toBe('Updated by agent');
    });

    it('should return 403 when non-author user tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);

      await expect(
        service.update('comment-123', updateDto, { id: 'user-456', sub: 'user-456' }, 'user')
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);

      await expect(
        service.update('comment-123', updateDto, { id: 'agent-456', sub: 'agent-456' }, 'agent')
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to edit any comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Admin edited',
      };

      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);
      mockPrismaService.client.comment.update.mockResolvedValue({
        ...mockComment,
        body: 'Admin edited',
      });

      const result = await service.update(
        'comment-123',
        updateDto,
        { id: 'admin-user', sub: 'admin-user', role: 'ADMIN' },
        'user'
      );

      expect(result.body).toBe('Admin edited');
    });

    it('should return 404 if comment not found', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body',
      };

      mockPrismaService.client.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.update('nonexistent-123', updateDto, { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });

    it('should preserve comment type when updating body', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body only',
      };

      const verificationComment = { ...mockComment, type: 'VERIFICATION' };
      mockPrismaService.client.comment.findUnique.mockResolvedValue(verificationComment);
      mockPrismaService.client.comment.update.mockResolvedValue({
        ...verificationComment,
        body: 'Updated body only',
      });

      const result = await service.update('comment-123', updateDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result.type).toBe('VERIFICATION');
      expect(result.body).toBe('Updated body only');
    });

    it('should update updatedAt timestamp when editing', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated',
      };

      const now = new Date();
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);
      mockPrismaService.client.comment.update.mockResolvedValue({
        ...mockComment,
        body: 'Updated',
        updatedAt: now,
      });

      const result = await service.update('comment-123', updateDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result.updatedAt).toEqual(now);
    });
  });

  describe('delete', () => {
    it('should allow author (user) to delete own comment', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);
      mockPrismaService.client.comment.delete.mockResolvedValue(mockComment);

      await service.delete('comment-123', { id: 'user-123', sub: 'user-123' }, 'user');

      expect(prismaService.client.comment.delete).toHaveBeenCalledWith({
        where: { id: 'comment-123' },
      });
    });

    it('should allow author (agent) to delete own comment', async () => {
      const agentComment = { ...mockComment, authorUserId: null, authorAgentId: 'agent-123' };
      mockPrismaService.client.comment.findUnique.mockResolvedValue(agentComment);
      mockPrismaService.client.comment.delete.mockResolvedValue(agentComment);

      await service.delete('comment-123', { id: 'agent-123', sub: 'agent-123' }, 'agent');

      expect(prismaService.client.comment.delete).toHaveBeenCalled();
    });

    it('should return 403 when non-author user tries to delete comment', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);

      await expect(
        service.delete('comment-123', { id: 'user-456', sub: 'user-456' }, 'user')
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to delete comment', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);

      await expect(
        service.delete('comment-123', { id: 'agent-456', sub: 'agent-456' }, 'agent')
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to delete any comment', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);
      mockPrismaService.client.comment.delete.mockResolvedValue(mockComment);

      await service.delete('comment-123', { id: 'admin-user', sub: 'admin-user', role: 'ADMIN' }, 'user');

      expect(prismaService.client.comment.delete).toHaveBeenCalledWith({
        where: { id: 'comment-123' },
      });
    });

    it('should return 404 if comment not found', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.delete('nonexistent-123', { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });

    it('should not allow MEMBER users to delete others\' comments', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);

      await expect(
        service.delete('comment-123', { id: 'user-456', sub: 'user-456', role: 'MEMBER' }, 'user')
      ).rejects.toThrow();
    });
  });

  describe('findById', () => {
    it('should find comment by id', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(mockComment);

      const result = await service.findById('comment-123');

      expect(result).toEqual(mockComment);
      expect(prismaService.client.comment.findUnique).toHaveBeenCalledWith({
        where: { id: 'comment-123' },
      });
    });

    it('should return null if comment not found', async () => {
      mockPrismaService.client.comment.findUnique.mockResolvedValue(null);

      const result = await service.findById('nonexistent-123');

      expect(result).toBeNull();
    });
  });
});
