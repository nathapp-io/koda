/**
 * US-004 — TicketsController response envelope
 *
 * Every controller method must return a JsonResponse instance.
 * These tests are RED until TicketsController is updated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TicketsController } from '../../src/tickets/tickets.controller';
import { TicketsService } from '../../src/tickets/tickets.service';
import { TicketTransitionsService } from '../../src/tickets/state-machine/ticket-transitions.service';
import { JsonResponse } from '../../src/common/json-response';

describe('TicketsController — JsonResponse envelope (US-004)', () => {
  let controller: TicketsController;

  const mockTicket = {
    id: 'ticket-1',
    number: 1,
    title: 'Fix bug',
    description: 'Something is broken',
    status: 'CREATED',
    type: 'BUG',
    priority: 'MEDIUM',
    projectId: 'proj-1',
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockComment = {
    id: 'comment-1',
    body: 'Verified',
    type: 'VERIFICATION',
    ticketId: 'ticket-1',
    createdAt: new Date(),
  };

  const mockTicketsService = {
    create: jest.fn().mockResolvedValue(mockTicket),
    findAll: jest.fn().mockResolvedValue([mockTicket]),
    findByRef: jest.fn().mockResolvedValue(mockTicket),
    update: jest.fn().mockResolvedValue(mockTicket),
    softDelete: jest.fn().mockResolvedValue({ ...mockTicket, deletedAt: new Date() }),
    assign: jest.fn().mockResolvedValue(mockTicket),
  };

  const mockTransitionsService = {
    verify: jest.fn().mockResolvedValue({ ticket: { ...mockTicket, status: 'VERIFIED' }, comment: mockComment }),
    start: jest.fn().mockResolvedValue({ ticket: { ...mockTicket, status: 'IN_PROGRESS' } }),
    fix: jest.fn().mockResolvedValue({ ticket: { ...mockTicket, status: 'VERIFY_FIX' }, comment: mockComment }),
    verifyFix: jest.fn().mockResolvedValue({ ticket: { ...mockTicket, status: 'CLOSED' }, comment: mockComment }),
    close: jest.fn().mockResolvedValue({ ticket: { ...mockTicket, status: 'CLOSED' } }),
    reject: jest.fn().mockResolvedValue({ ticket: { ...mockTicket, status: 'REJECTED' }, comment: mockComment }),
  };

  const userReq: any = { user: { sub: 'user-1', role: 'MEMBER' } };
  const adminReq: any = { user: { sub: 'user-1', role: 'ADMIN' } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [
        { provide: TicketsService, useValue: mockTicketsService },
        { provide: TicketTransitionsService, useValue: mockTransitionsService },
      ],
    }).compile();

    controller = module.get<TicketsController>(TicketsController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /projects/:slug/tickets', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { title: 'Fix bug', type: 'BUG', priority: 'MEDIUM' };
      const result = await controller.create('koda', dto as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps ticket under result.data', async () => {
      const dto = { title: 'Fix bug', type: 'BUG', priority: 'MEDIUM' };
      const result = await controller.create('koda', dto as any, userReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
      expect(envelope.data).toHaveProperty('status', 'CREATED');
    });
  });

  describe('GET /projects/:slug/tickets', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findAll('koda', {});
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps tickets list under result.data', async () => {
      const result = await controller.findAll('koda', {});
      const envelope = result as unknown as JsonResponse;
      expect(Array.isArray(envelope.data)).toBe(true);
    });
  });

  describe('GET /projects/:slug/tickets/:ref', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findByRef('koda', 'KODA-1');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps ticket under result.data', async () => {
      const result = await controller.findByRef('koda', 'KODA-1');
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
    });
  });

  describe('PATCH /projects/:slug/tickets/:ref', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.update('koda', 'KODA-1', { title: 'Updated' } as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('DELETE /projects/:slug/tickets/:ref', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.softDelete('koda', 'KODA-1', adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/assign', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.assign('koda', 'KODA-1', { userId: 'user-2' });
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/verify', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { body: 'Looks good', type: 'VERIFICATION' };
      const result = await controller.verify('koda', 'KODA-1', dto as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/start', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.start('koda', 'KODA-1', userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/fix', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { body: 'Fixed in PR #42', type: 'FIX_REPORT' };
      const result = await controller.fix('koda', 'KODA-1', dto as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/verify-fix', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { body: 'Approved', type: 'REVIEW' };
      const result = await controller.verifyFix('koda', 'KODA-1', dto as any, 'true', userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/reject', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { body: 'Not valid', type: 'GENERAL' };
      const result = await controller.reject('koda', 'KODA-1', dto as any, userReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });
});
