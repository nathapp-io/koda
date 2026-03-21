/**
 * US-004 — LabelsController response envelope
 *
 * Every controller method that returns data must return a JsonResponse instance.
 * DELETE (204 No Content) methods are excluded.
 * These tests are RED until LabelsController is updated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { LabelsController } from '../../src/labels/labels.controller';
import { LabelsService } from '../../src/labels/labels.service';
import { JsonResponse } from '@nathapp/nestjs-common';

describe('LabelsController — JsonResponse envelope (US-004)', () => {
  let controller: LabelsController;

  const mockLabel = {
    id: 'label-1',
    name: 'bug',
    color: '#ff0000',
    projectId: 'proj-1',
    createdAt: new Date(),
  };

  const mockTicketWithLabels = {
    id: 'ticket-1',
    labels: [mockLabel],
  };

  const mockLabelsService = {
    create: jest.fn().mockResolvedValue(mockLabel),
    findByProject: jest.fn().mockResolvedValue([mockLabel]),
    delete: jest.fn().mockResolvedValue(undefined),
    assignToTicket: jest.fn().mockResolvedValue(mockTicketWithLabels),
    removeFromTicket: jest.fn().mockResolvedValue(undefined),
  };

  const adminUser = { sub: 'user-1', role: 'ADMIN' };
  const adminReq: any = { user: adminUser };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LabelsController],
      providers: [{ provide: LabelsService, useValue: mockLabelsService }],
    }).compile();

    controller = module.get<LabelsController>(LabelsController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /projects/:slug/labels (createFromHttp)', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { name: 'bug', color: '#ff0000' };
      const result = await controller.createFromHttp('koda', dto as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps label under result.data', async () => {
      const dto = { name: 'bug', color: '#ff0000' };
      const result = await controller.createFromHttp('koda', dto as any, adminReq);
      const envelope = result as unknown as JsonResponse<any>;
      expect(envelope.data).toHaveProperty('id');
      expect(envelope.data).toHaveProperty('name', 'bug');
    });
  });

  describe('GET /projects/:slug/labels (findByProjectFromHttp)', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findByProjectFromHttp('koda');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps labels array under result.data', async () => {
      const result = await controller.findByProjectFromHttp('koda');
      const envelope = result as unknown as JsonResponse<any>;
      expect(Array.isArray(envelope.data)).toBe(true);
    });
  });

  describe('POST /projects/:slug/tickets/:ref/labels (assignLabelFromHttp)', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { labelId: 'label-1' };
      const result = await controller.assignLabelFromHttp('koda', 'KODA-1', dto as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps updated ticket under result.data', async () => {
      const dto = { labelId: 'label-1' };
      const result = await controller.assignLabelFromHttp('koda', 'KODA-1', dto as any, adminReq);
      const envelope = result as unknown as JsonResponse<any>;
      expect(envelope.data).toHaveProperty('id');
    });
  });
});
