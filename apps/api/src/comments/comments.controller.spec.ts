import { Test, TestingModule } from '@nestjs/testing';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { ForbiddenException as _ForbiddenException, NotFoundException as _NotFoundException } from '@nestjs/common';
import { CreateCommentDto, CommentTypeEnum } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

describe('CommentsController', () => {
  let controller: CommentsController;
  let service: CommentsService;

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

  const mockAdminUser = {
    sub: 'user-admin',
    email: 'admin@example.com',
    role: 'ADMIN',
  };

  const mockMemberUser = {
    sub: 'user-123',
    email: 'member@example.com',
    role: 'MEMBER',
  };

  const mockOtherUser = {
    sub: 'user-456',
    email: 'other@example.com',
    role: 'MEMBER',
  };

  const mockAgent = {
    sub: 'agent-123',
    slug: 'test-agent',
  };

  const mockCommentsService = {
    create: jest.fn(),
    findByTicket: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommentsController],
      providers: [{ provide: CommentsService, useValue: mockCommentsService }],
    }).compile();

    controller = module.get<CommentsController>(CommentsController);
    service = module.get<CommentsService>(CommentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/projects/:slug/tickets/:ref/comments', () => {
    it('should create a comment on a ticket', async () => {
      const createDto: CreateCommentDto = {
        body: 'This is a test comment',
        type: CommentTypeEnum.GENERAL,
      };

      mockCommentsService.create.mockResolvedValue(mockComment);

      const result = await controller.create('koda', 'KODA-1', createDto, mockMemberUser, 'user');

      expect(result).toEqual(mockComment);
      expect(service.create).toHaveBeenCalledWith('koda', 'KODA-1', createDto, mockMemberUser, 'user');
    });

    it('should allow authenticated user to add comment', async () => {
      const createDto: CreateCommentDto = {
        body: 'User comment',
        type: CommentTypeEnum.GENERAL,
      };

      const userComment = { ...mockComment, authorUserId: 'user-123' };
      mockCommentsService.create.mockResolvedValue(userComment);

      const result = await controller.create('koda', 'KODA-1', createDto, mockMemberUser, 'user');

      expect(result.authorUserId).toBe('user-123');
      expect(result.authorAgentId).toBeNull();
    });

    it('should allow authenticated agent to add comment', async () => {
      const createDto: CreateCommentDto = {
        body: 'Agent comment',
        type: CommentTypeEnum.GENERAL,
      };

      const agentComment = {
        ...mockComment,
        authorUserId: null,
        authorAgentId: 'agent-123',
      };
      mockCommentsService.create.mockResolvedValue(agentComment);

      const result = await controller.create('koda', 'KODA-1', createDto, mockAgent, 'agent');

      expect(result.authorAgentId).toBe('agent-123');
      expect(result.authorUserId).toBeNull();
    });

    it('should store comment type from request', async () => {
      const createDto: CreateCommentDto = {
        body: 'Verification comment',
        type: CommentTypeEnum.VERIFICATION,
      };

      const verificationComment = { ...mockComment, type: 'VERIFICATION' };
      mockCommentsService.create.mockResolvedValue(verificationComment);

      const result = await controller.create('koda', 'KODA-1', createDto, mockMemberUser, 'user');

      expect(result.type).toBe('VERIFICATION');
    });

    it('should return comment with all fields', async () => {
      const createDto: CreateCommentDto = {
        body: 'Test comment',
        type: CommentTypeEnum.FIX_REPORT,
      };

      const fullComment = {
        ...mockComment,
        type: 'FIX_REPORT',
        body: 'Test comment',
      };
      mockCommentsService.create.mockResolvedValue(fullComment);

      const result = await controller.create('koda', 'KODA-1', createDto, mockMemberUser, 'user');

      expect(result.id).toBeDefined();
      expect(result.body).toBe('Test comment');
      expect(result.type).toBe('FIX_REPORT');
      expect(result.authorUserId).toBeDefined();
      expect(result.createdAt).toBeDefined();
    });
  });

  describe('GET /api/projects/:slug/tickets/:ref/comments', () => {
    it('should list all comments for a ticket', async () => {
      const comments = [
        mockComment,
        { ...mockComment, id: 'comment-124', body: 'Second comment' },
      ];

      mockCommentsService.findByTicket.mockResolvedValue(comments);

      const result = await controller.listByTicket('koda', 'KODA-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockComment);
      expect(result[1].body).toBe('Second comment');
      expect(service.findByTicket).toHaveBeenCalledWith('koda', 'KODA-1');
    });

    it('should return empty array when no comments found', async () => {
      mockCommentsService.findByTicket.mockResolvedValue([]);

      const result = await controller.listByTicket('koda', 'KODA-1');

      expect(result).toEqual([]);
    });

    it('should return comments in chronological order', async () => {
      const date1 = new Date('2026-01-01');
      const date2 = new Date('2026-01-02');
      const comments = [
        { ...mockComment, id: 'comment-1', createdAt: date1 },
        { ...mockComment, id: 'comment-2', createdAt: date2 },
      ];

      mockCommentsService.findByTicket.mockResolvedValue(comments);

      const result = await controller.listByTicket('koda', 'KODA-1');

      expect(result[0].createdAt.getTime()).toBeLessThanOrEqual(result[1].createdAt.getTime());
    });
  });

  describe('PATCH /api/comments/:id', () => {
    it('should allow comment author (user) to edit own comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated comment body',
      };

      const updatedComment = { ...mockComment, body: 'Updated comment body' };
      mockCommentsService.update.mockResolvedValue(updatedComment);

      const result = await controller.update('comment-123', updateDto, mockMemberUser, 'user');

      expect(result.body).toBe('Updated comment body');
      expect(service.update).toHaveBeenCalledWith(
        'comment-123',
        updateDto,
        mockMemberUser,
        'user'
      );
    });

    it('should allow comment author (agent) to edit own comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated by agent',
      };

      const agentComment = {
        ...mockComment,
        authorUserId: null,
        authorAgentId: 'agent-123',
      };
      const updatedComment = { ...agentComment, body: 'Updated by agent' };
      mockCommentsService.update.mockResolvedValue(updatedComment);

      const result = await controller.update('comment-123', updateDto, mockAgent, 'agent');

      expect(result.body).toBe('Updated by agent');
    });

    it('should return 403 when non-author user tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      mockCommentsService.update.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.update('comment-123', updateDto, mockOtherUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to edit comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Unauthorized edit',
      };

      const otherAgent = { id: 'agent-456', sub: 'agent-456', slug: 'other-agent' };
      mockCommentsService.update.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.update('comment-123', updateDto, otherAgent, 'agent')
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to edit any comment', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Admin edited',
      };

      const updatedComment = { ...mockComment, body: 'Admin edited' };
      mockCommentsService.update.mockResolvedValue(updatedComment);

      const result = await controller.update('comment-123', updateDto, mockAdminUser, 'user');

      expect(result.body).toBe('Admin edited');
    });

    it('should preserve comment type when updating', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body only',
      };

      const verificationComment = { ...mockComment, type: 'VERIFICATION' };
      const updatedComment = {
        ...verificationComment,
        body: 'Updated body only',
      };
      mockCommentsService.update.mockResolvedValue(updatedComment);

      const result = await controller.update('comment-123', updateDto, mockMemberUser, 'user');

      expect(result.type).toBe('VERIFICATION');
    });

    it('should return 404 if comment not found', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated body',
      };

      mockCommentsService.update.mockRejectedValue(new Error('Not Found'));

      await expect(
        controller.update('nonexistent-123', updateDto, mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should update the updatedAt timestamp', async () => {
      const updateDto: UpdateCommentDto = {
        body: 'Updated',
      };

      const now = new Date();
      const updatedComment = { ...mockComment, body: 'Updated', updatedAt: now };
      mockCommentsService.update.mockResolvedValue(updatedComment);

      const result = await controller.update('comment-123', updateDto, mockMemberUser, 'user');

      expect(result.updatedAt).toEqual(now);
    });
  });

  describe('DELETE /api/comments/:id', () => {
    it('should allow comment author (user) to delete own comment', async () => {
      mockCommentsService.delete.mockResolvedValue(undefined);

      await controller.delete('comment-123', mockMemberUser, 'user');

      expect(service.delete).toHaveBeenCalledWith('comment-123', mockMemberUser, 'user');
    });

    it('should allow comment author (agent) to delete own comment', async () => {
      mockCommentsService.delete.mockResolvedValue(undefined);

      await controller.delete('comment-123', mockAgent, 'agent');

      expect(service.delete).toHaveBeenCalledWith('comment-123', mockAgent, 'agent');
    });

    it('should return 403 when non-author user tries to delete comment', async () => {
      mockCommentsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('comment-123', mockOtherUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 403 when non-author agent tries to delete comment', async () => {
      const otherAgent = { id: 'agent-456', sub: 'agent-456', slug: 'other-agent' };
      mockCommentsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('comment-123', otherAgent, 'agent')
      ).rejects.toThrow();
    });

    it('should allow ADMIN user to delete any comment', async () => {
      mockCommentsService.delete.mockResolvedValue(undefined);

      await controller.delete('comment-123', mockAdminUser, 'user');

      expect(service.delete).toHaveBeenCalledWith('comment-123', mockAdminUser, 'user');
    });

    it('should not allow MEMBER user to delete other users\' comments', async () => {
      mockCommentsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('comment-123', mockOtherUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 404 if comment not found', async () => {
      mockCommentsService.delete.mockRejectedValue(new Error('Not Found'));

      await expect(
        controller.delete('nonexistent-123', mockMemberUser, 'user')
      ).rejects.toThrow();
    });
  });

  describe('Edge cases', () => {
    it('should handle comment with agent author correctly', async () => {
      const agentComment = {
        ...mockComment,
        authorUserId: null,
        authorAgentId: 'agent-123',
      };

      mockCommentsService.findByTicket.mockResolvedValue([agentComment]);

      const result = await controller.listByTicket('koda', 'KODA-1');

      expect(result[0].authorAgentId).toBe('agent-123');
      expect(result[0].authorUserId).toBeNull();
    });

    it('should handle concurrent comment creation', async () => {
      const createDto: CreateCommentDto = {
        body: 'First comment',
        type: CommentTypeEnum.GENERAL,
      };

      const comment1 = { ...mockComment, id: 'comment-1' };
      const comment2 = { ...mockComment, id: 'comment-2', body: 'Second comment' };

      mockCommentsService.create
        .mockResolvedValueOnce(comment1)
        .mockResolvedValueOnce(comment2);

      const [result1, result2] = await Promise.all([
        controller.create('koda', 'KODA-1', createDto, mockMemberUser, 'user'),
        controller.create('koda', 'KODA-1', createDto, mockOtherUser, 'user'),
      ]);

      expect(result1.id).toBe('comment-1');
      expect(result2.id).toBe('comment-2');
    });

    it('should handle all comment types correctly', async () => {
      const types = [
        CommentTypeEnum.VERIFICATION,
        CommentTypeEnum.FIX_REPORT,
        CommentTypeEnum.REVIEW,
        CommentTypeEnum.STATUS_CHANGE,
        CommentTypeEnum.GENERAL,
      ];

      for (const commentType of types) {
        const createDto: CreateCommentDto = {
          body: `This is a ${commentType} comment`,
          type: commentType,
        };

        const typedComment = { ...mockComment, type: commentType };
        mockCommentsService.create.mockResolvedValue(typedComment);

        const result = await controller.create('koda', 'KODA-1', createDto, mockMemberUser, 'user');

        expect(result.type).toBe(commentType);
      }
    });
  });
});
