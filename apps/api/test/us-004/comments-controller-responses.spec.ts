/**
 * US-004 — CommentsController response envelope
 *
 * Every controller method must return a JsonResponse instance.
 * DELETE returns no content (void), so only create/list/update are tested.
 * These tests are RED until CommentsController is updated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { CommentsController } from '../../src/comments/comments.controller';
import { CommentsService } from '../../src/comments/comments.service';
import { JsonResponse } from '@nathapp/nestjs-common';

describe('CommentsController — JsonResponse envelope (US-004)', () => {
  let controller: CommentsController;

  const mockComment = {
    id: 'comment-1',
    body: 'Looks good',
    type: 'GENERAL',
    ticketId: 'ticket-1',
    authorUserId: 'user-1',
    authorAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockCommentsService = {
    create: jest.fn().mockResolvedValue(mockComment),
    findByTicket: jest.fn().mockResolvedValue([mockComment]),
    findById: jest.fn().mockResolvedValue(mockComment),
    update: jest.fn().mockResolvedValue({ ...mockComment, body: 'Updated' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const userReq: any = { user: { sub: 'user-1', role: 'MEMBER' } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommentsController],
      providers: [{ provide: CommentsService, useValue: mockCommentsService }],
    }).compile();

    controller = module.get<CommentsController>(CommentsController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /projects/:slug/tickets/:ref/comments (createFromHttp)', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { body: 'Looks good', type: 'GENERAL' };
      const result = await controller.createFromHttp('koda', 'KODA-1', dto as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps comment under result.data', async () => {
      const dto = { body: 'Looks good', type: 'GENERAL' };
      const result = await controller.createFromHttp('koda', 'KODA-1', dto as any, userReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
      expect(envelope.data).toHaveProperty('body');
    });
  });

  describe('GET /projects/:slug/tickets/:ref/comments (listByTicketFromHttp)', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.listByTicketFromHttp('koda', 'KODA-1');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps comments array under result.data', async () => {
      const result = await controller.listByTicketFromHttp('koda', 'KODA-1');
      const envelope = result as unknown as JsonResponse;
      expect(Array.isArray(envelope.data)).toBe(true);
    });
  });

  describe('PATCH /comments/:id (updateFromHttp)', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { body: 'Updated text' };
      const result = await controller.updateFromHttp('comment-1', dto as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps updated comment under result.data', async () => {
      const dto = { body: 'Updated text' };
      const result = await controller.updateFromHttp('comment-1', dto as any, userReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
    });
  });
});
