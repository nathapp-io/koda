/**
 * US-004 — ProjectsController response envelope
 *
 * Every controller method must return a JsonResponse instance.
 * These tests are RED until ProjectsController is updated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from '../../src/projects/projects.controller';
import { ProjectsService } from '../../src/projects/projects.service';
import { JsonResponse } from '/nestjs-common';

describe('ProjectsController — JsonResponse envelope (US-004)', () => {
  let controller: ProjectsController;

  const mockProject = {
    id: 'proj-1',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev tracker',
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockProjectsService = {
    create: jest.fn().mockResolvedValue(mockProject),
    findAll: jest.fn().mockResolvedValue([mockProject]),
    findBySlug: jest.fn().mockResolvedValue(mockProject),
    update: jest.fn().mockResolvedValue(mockProject),
    softDelete: jest.fn().mockResolvedValue({ ...mockProject, deletedAt: new Date() }),
  };

  const adminReq: any = { user: { sub: 'user-1', role: 'ADMIN' } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [{ provide: ProjectsService, useValue: mockProjectsService }],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /projects', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { name: 'Koda', slug: 'koda', key: 'KODA' };
      const result = await controller.create(dto as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps project data under result.data', async () => {
      const dto = { name: 'Koda', slug: 'koda', key: 'KODA' };
      const result = await controller.create(dto as any, adminReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
      expect(envelope.data).toHaveProperty('slug', 'koda');
    });
  });

  describe('GET /projects', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findAll();
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps projects array under result.data', async () => {
      const result = await controller.findAll();
      const envelope = result as unknown as JsonResponse;
      expect(Array.isArray(envelope.data)).toBe(true);
    });
  });

  describe('GET /projects/:slug', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findBySlug('koda');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps project under result.data', async () => {
      const result = await controller.findBySlug('koda');
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('slug', 'koda');
    });
  });

  describe('PATCH /projects/:slug', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.update('koda', { name: 'Updated' } as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps updated project under result.data', async () => {
      const result = await controller.update('koda', { name: 'Updated' } as any, adminReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
    });
  });

  describe('DELETE /projects/:slug', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.remove('koda', adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps soft-deleted project under result.data with deletedAt set', async () => {
      const result = await controller.remove('koda', adminReq);
      const envelope = result as unknown as JsonResponse<typeof mockProject>;
      expect((envelope.data as any).deletedAt).not.toBeNull();
    });
  });
});
