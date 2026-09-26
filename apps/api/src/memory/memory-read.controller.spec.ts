import { ForbiddenAppException, JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { Page } from '@nathapp/nestjs-common';
import type { UserPrincipal } from '../auth/principal/koda-principal.types';
import { MemoryKind } from '../common/enums';
import { MemoryGovernanceService } from './memory-governance.service';
import { MemoryItem } from './memory-item-repository';
import { MemoryReadController } from './memory-read.controller';
import { ProjectAccessService } from '../projects/project-access.service';

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

  const mockProjectAccessService = {
    findProjectIdBySlug: jest.fn(),
    assertProjectMembership: jest.fn(),
  };

  const principal = makeUserPrincipal();

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new MemoryReadController(
      mockGovernanceService as unknown as MemoryGovernanceService,
      mockProjectAccessService as unknown as ProjectAccessService,
    );
  });

  describe('getMemory', () => {
    describe('AC1: returns 200 with records and total for active memory items', () => {
      it('returns records array matching the service result', async () => {
        const items = [makeMemoryItem(), makeMemoryItem({ id: 'mem-2' })];
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 2, items));

        const result = await controller.getMemory('my-project', principal, {} as never);

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.records).toEqual(items);
      });

      it('returns total equal to the service total', async () => {
        const items = [makeMemoryItem()];
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 42, items));

        const result = await controller.getMemory('my-project', principal, {} as never);

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.total).toBe(42);
      });

      it('calls service with the projectId resolved from the slug', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-resolved-id');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', principal, {} as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-resolved-id' }),
          expect.objectContaining({ current: 1, size: 20 }),
        );
      });
    });

    describe('AC2: kind filter', () => {
      it('passes kind=DECISION to the service when kind query param is provided', async () => {
        const items = [makeMemoryItem({ kind: MemoryKind.DECISION })];
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, items));

        await controller.getMemory('my-project', principal, { kind: 'DECISION' } as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'DECISION' }),
          expect.anything(),
        );
      });

      it('does not include kind in the service query when kind is not provided', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', principal, {} as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.kind).toBeUndefined();
      });
    });

    describe('AC3: default status filters to active with non-expired ttlAt', () => {
      it('calls service without a status field when no status param is provided', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', principal, {} as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.status).toBeUndefined();
      });
    });

    describe('AC4: status=superseded filter', () => {
      it('passes status=superseded to service when status query param is superseded', async () => {
        const items = [makeMemoryItem({ status: 'superseded' })];
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, items));

        await controller.getMemory('my-project', principal, { status: 'superseded' } as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
          expect.anything(),
        );
      });

      it('does not include status in the service query when status is omitted', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', principal, {} as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.status).toBeUndefined();
      });
    });

    describe('AC5: pagination', () => {
      it('parses paging strings and forwards filters and page separately', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

        await controller.getMemory('my-project', principal, { current: '2', size: '5', kind: 'FACT' } as never);

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-123', kind: 'FACT' }),
          { current: 2, size: 5 },
        );
      });

      it('returns the six-field page envelope', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, [{ id: 'm1' }]));

        const res = await controller.getMemory('my-project', principal, {} as never);

        expect(Object.keys(res.data).sort()).toEqual(['current', 'hasNext', 'hasPrev', 'records', 'size', 'total']);
        expect(res.data.records).toEqual([{ id: 'm1' }]);
      });
    });

    describe('AC7: 404 for unknown or soft-deleted project', () => {
      it('throws NotFoundAppException when the slug does not resolve to any project', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('unknown-slug', principal, {} as never)).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('throws NotFoundAppException when the project has been soft-deleted', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('deleted-project', principal, {} as never)).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('does not call assertProjectMembership or getProjectMemory when the slug fails to resolve', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('unknown-slug', principal, {} as never)).rejects.toThrow();

        expect(mockProjectAccessService.assertProjectMembership).not.toHaveBeenCalled();
        expect(mockGovernanceService.getProjectMemory).not.toHaveBeenCalled();
      });
    });

    describe('AC8: 403 for non-member principal', () => {
      it('throws ForbiddenAppException when the principal is not a project member', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockRejectedValue(
          new ForbiddenAppException({}, 'projects'),
        );

        await expect(controller.getMemory('my-project', principal, {} as never)).rejects.toThrow(
          ForbiddenAppException,
        );
      });

      it('does not call getProjectMemory when the membership check rejects', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockRejectedValue(
          new ForbiddenAppException({}, 'projects'),
        );

        await expect(controller.getMemory('my-project', principal, {} as never)).rejects.toThrow();

        expect(mockGovernanceService.getProjectMemory).not.toHaveBeenCalled();
      });

      it('calls assertProjectMembership with the resolved projectId and principal', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', principal, {} as never);

        expect(mockProjectAccessService.assertProjectMembership).toHaveBeenCalledWith(
          'project-123',
          principal,
        );
      });
    });
  });
});
