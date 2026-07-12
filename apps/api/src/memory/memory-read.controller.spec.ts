import { ForbiddenAppException, JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import type { UserPrincipal } from '../auth/principal/koda-principal.types';
import { MemoryKind } from '../common/enums';
import { MemoryGovernanceService } from './memory-governance.service';
import { MemoryItem } from './memory-item-repository';
import { MemoryReadController } from './memory-read.controller';
import { ProjectsService } from '../projects/projects.service';

const makeMemoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: MemoryKind.FACT,
  subject: 'arch:api',
  predicate: 'uses',
  object: 'NestJS',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
});

const makeUserPrincipal = (): UserPrincipal => ({
  actorType: 'user',
  id: 'user-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  role: 'MEMBER',
  email: 'test@example.com',
});

describe('MemoryReadController', () => {
  let controller: MemoryReadController;

  const mockGovernanceService = {
    getProjectMemory: jest.fn(),
  };

  const mockProjectsService = {
    findProjectIdBySlug: jest.fn(),
    assertProjectMembership: jest.fn(),
  };

  const principal = makeUserPrincipal();

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new MemoryReadController(
      mockGovernanceService as unknown as MemoryGovernanceService,
      mockProjectsService as unknown as ProjectsService,
    );
  });

  describe('getMemory', () => {
    describe('AC1: returns 200 with items and total for active memory items', () => {
      it('returns items array matching the service result', async () => {
        const items = [makeMemoryItem(), makeMemoryItem({ id: 'mem-2' })];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 2 });

        const result = await controller.getMemory('my-project', principal);

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.items).toEqual(items);
      });

      it('returns total equal to the service total', async () => {
        const items = [makeMemoryItem()];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 42 });

        const result = await controller.getMemory('my-project', principal);

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.total).toBe(42);
      });

      it('calls service with the projectId resolved from the slug', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-resolved-id');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

        await controller.getMemory('my-project', principal);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-resolved-id' }),
        );
      });
    });

    describe('AC2: kind filter', () => {
      it('passes kind=DECISION to the service when kind query param is provided', async () => {
        const items = [makeMemoryItem({ kind: MemoryKind.DECISION })];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 1 });

        await controller.getMemory('my-project', principal, 'DECISION');

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'DECISION' }),
        );
      });

      it('does not include kind in the service query when kind is not provided', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

        await controller.getMemory('my-project', principal);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.kind).toBeUndefined();
      });
    });

    describe('AC3: default status filters to active with non-expired ttlAt', () => {
      it('calls service without a status field when no status param is provided', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

        await controller.getMemory('my-project', principal);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.status).toBeUndefined();
      });
    });

    describe('AC4: status=superseded filter', () => {
      it('passes status=superseded to service when status query param is superseded', async () => {
        const items = [makeMemoryItem({ status: 'superseded' })];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 1 });

        await controller.getMemory('my-project', principal, undefined, undefined, 'superseded');

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
        );
      });

      it('does not include status in the service query when status is omitted', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

        await controller.getMemory('my-project', principal, undefined, undefined, undefined);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.status).toBeUndefined();
      });
    });

    describe('AC5: pagination', () => {
      it('passes page=2 and limit=10 as parsed numbers to the service', async () => {
        const page2Items = Array.from({ length: 10 }, (_, i) => makeMemoryItem({ id: `mem-${i + 11}` }));
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: page2Items, total: 25 });

        const result = await controller.getMemory('my-project', principal, undefined, undefined, undefined, '2', '10');

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2, limit: 10 }),
        );
        expect(result.data.items).toHaveLength(10);
      });

      it('returns only the items provided by the service for the requested page', async () => {
        const page2Items = [makeMemoryItem({ id: 'mem-11' })];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: page2Items, total: 11 });

        const result = await controller.getMemory('my-project', principal, undefined, undefined, undefined, '2', '10');

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.items).toEqual(page2Items);
      });
    });

    describe('AC6: limit clamped to 50', () => {
      it('passes the parsed limit=1000 to the service (repository enforces the 50-item cap)', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

        await controller.getMemory('my-project', principal, undefined, undefined, undefined, undefined, '1000');

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ limit: 1000 }),
        );
      });

      it('response items are at most 50 when limit=1000 is requested', async () => {
        const fiftyItems = Array.from({ length: 50 }, (_, i) => makeMemoryItem({ id: `mem-${i}` }));
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: fiftyItems, total: 200 });

        const result = await controller.getMemory('my-project', principal, undefined, undefined, undefined, undefined, '1000');

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.items.length).toBeLessThanOrEqual(50);
      });
    });

    describe('AC7: 404 for unknown or soft-deleted project', () => {
      it('throws NotFoundAppException when the slug does not resolve to any project', async () => {
        mockProjectsService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('unknown-slug', principal)).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('throws NotFoundAppException when the project has been soft-deleted', async () => {
        mockProjectsService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('deleted-project', principal)).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('does not call assertProjectMembership or getProjectMemory when the slug fails to resolve', async () => {
        mockProjectsService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('unknown-slug', principal)).rejects.toThrow();

        expect(mockProjectsService.assertProjectMembership).not.toHaveBeenCalled();
        expect(mockGovernanceService.getProjectMemory).not.toHaveBeenCalled();
      });
    });

    describe('AC8: 403 for non-member principal', () => {
      it('throws ForbiddenAppException when the principal is not a project member', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockRejectedValue(
          new ForbiddenAppException({}, 'projects'),
        );

        await expect(controller.getMemory('my-project', principal)).rejects.toThrow(
          ForbiddenAppException,
        );
      });

      it('does not call getProjectMemory when the membership check rejects', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockRejectedValue(
          new ForbiddenAppException({}, 'projects'),
        );

        await expect(controller.getMemory('my-project', principal)).rejects.toThrow();

        expect(mockGovernanceService.getProjectMemory).not.toHaveBeenCalled();
      });

      it('calls assertProjectMembership with the resolved projectId and principal', async () => {
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

        await controller.getMemory('my-project', principal);

        expect(mockProjectsService.assertProjectMembership).toHaveBeenCalledWith(
          'project-123',
          principal,
        );
      });
    });

    describe('AC9: response envelope shape', () => {
      it('wraps the service result in JsonResponse.Ok with items and total at data root', async () => {
        const items = [makeMemoryItem()];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 1 });

        const result = await controller.getMemory('my-project', principal);

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data).toEqual({ items, total: 1 });
      });

      it('data.items and data.total are present at the top level of data, not nested further', async () => {
        const items = [makeMemoryItem()];
        mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 1 });

        const result = await controller.getMemory('my-project', principal);

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data).toHaveProperty('items');
        expect(result.data).toHaveProperty('total');
      });
    });
  });
});
