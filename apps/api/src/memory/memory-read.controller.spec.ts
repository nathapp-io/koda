import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { Page } from '@nathapp/nestjs-common';
import { MemoryKind } from '../common/enums';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { MemoryGovernanceService } from './memory-governance.service';
import { MemoryItem } from './memory-item-repository';
import { MemoryReadController } from './memory-read.controller';
import { ProjectAccessService } from '../projects/project-access.service';

const makeMemoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-123',
  scope: 'project',
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

/** The caller the route reads with `@Principal()`; the handler builds the read's owner from it (US-005). */
const agent = (id = 'agent-1') => ({ actorType: 'agent', id } as unknown as KodaPrincipal);
const user = (id = 'user-1') => ({ actorType: 'user', id } as unknown as KodaPrincipal);

describe('MemoryReadController', () => {
  let controller: MemoryReadController;

  const mockGovernanceService = {
    getProjectMemory: vi.fn(),
    exportProjectMemory: vi.fn(),
  };

  const mockProjectAccessService = {
    findProjectIdBySlug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 2, items));

        const result = await controller.getMemory('my-project', {} as never, agent());

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.records).toEqual(items);
      });

      it('returns total equal to the service total', async () => {
        const items = [makeMemoryItem()];
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 42, items));

        const result = await controller.getMemory('my-project', {} as never, agent());

        expect(result).toBeInstanceOf(JsonResponse);
        expect(result.data.total).toBe(42);
      });

      it('calls service with the projectId resolved from the slug', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-resolved-id');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, agent());

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
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, items));

        await controller.getMemory('my-project', { kind: 'DECISION' } as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'DECISION' }),
          expect.anything(),
        );
      });

      it('does not include kind in the service query when kind is not provided', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.kind).toBeUndefined();
      });
    });

    describe('AC3: default status filters to active with non-expired ttlAt', () => {
      it('calls service without a status field when no status param is provided', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.status).toBeUndefined();
      });
    });

    describe('AC4: status=superseded filter', () => {
      it('passes status=superseded to service when status query param is superseded', async () => {
        const items = [makeMemoryItem({ status: 'superseded' })];
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, items));

        await controller.getMemory('my-project', { status: 'superseded' } as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
          expect.anything(),
        );
      });

      it('does not include status in the service query when status is omitted', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.status).toBeUndefined();
      });
    });

    describe('AC5: pagination', () => {
      it('parses paging strings and forwards filters and page separately', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

        await controller.getMemory('my-project', { current: '2', size: '5', kind: 'FACT' } as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-123', kind: 'FACT' }),
          { current: 2, size: 5 },
        );
      });

      it('returns the six-field page envelope', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, [{ id: 'm1' }]));

        const res = await controller.getMemory('my-project', {} as never, agent());

        expect(Object.keys(res.data).sort()).toEqual(['current', 'hasNext', 'hasPrev', 'records', 'size', 'total']);
        expect(res.data.records).toEqual([{ id: 'm1' }]);
      });
    });

    describe('AC7: 404 for unknown or soft-deleted project', () => {
      it('throws NotFoundAppException when the slug does not resolve to any project', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('unknown-slug', {} as never, agent())).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('throws NotFoundAppException when the project has been soft-deleted', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('deleted-project', {} as never, agent())).rejects.toThrow(
          NotFoundAppException,
        );
      });

      it('does not call getProjectMemory when the slug fails to resolve', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(
          new NotFoundAppException({}, 'projects'),
        );

        await expect(controller.getMemory('unknown-slug', {} as never, agent())).rejects.toThrow();

        expect(mockGovernanceService.getProjectMemory).not.toHaveBeenCalled();
      });
    });

    // US-008: the membership decision and the `memory.read` key are the guard's (`ProjectMembershipGuard,
    // RequiresGuard` on the route); the handler resolves the slug and reads the page. Their behaviour is covered
    // over real HTTP by test/integration/memory/permissions-memory-routes.integration.spec.ts.
    describe('US-008: the handler no longer decides membership itself', () => {
      it('reads the page for a member without calling assertProjectMembership', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
      });

      it('declares the read guards and the memory.read key on the route', () => {
        const guards = Reflect.getMetadata('__guards__', MemoryReadController.prototype.getMemory) as unknown[];
        const requires = Reflect.getMetadata('koda:requires', MemoryReadController.prototype.getMemory) as {
          keys: string[];
          enforcedBy: string;
        };

        expect(guards?.map((guard) => (guard as { name: string }).name)).toEqual([
          'ProjectMembershipGuard',
          'RequiresGuard',
        ]);
        expect(requires).toMatchObject({ keys: ['memory.read'], enforcedBy: 'guard' });
      });
    });

    // US-005: the caller whose user-scoped notes the page includes. The handler is the only place the owner is
    // built, so a request can never name one.
    describe('US-005: the caller is the owner of the user rows a read includes', () => {
      it('AC-8: passes an agent caller as owner { ownerType: AGENT, ownerId: <id> }', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, agent('agent-A'));

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ owner: { ownerType: 'AGENT', ownerId: 'agent-A' } }),
          expect.anything(),
        );
      });

      it('passes a human caller as owner { ownerType: USER, ownerId: <id> }', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', {} as never, user('user-A'));

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ owner: { ownerType: 'USER', ownerId: 'user-A' } }),
          expect.anything(),
        );
      });

      it('ignores an owner supplied in the query and passes the principal role instead', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory(
          'my-project',
          { owner: { ownerType: 'AGENT', ownerId: 'someone-else' }, ownerId: 'someone-else' } as never,
          agent('agent-A'),
        );

        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.owner).toEqual({ ownerType: 'AGENT', ownerId: 'agent-A' });
      });

      it('forwards the requested scope to the service', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', { scope: 'user' } as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
          expect.objectContaining({ scope: 'user' }),
          expect.anything(),
        );
      });
    });

    describe('security: query params cannot override the membership-resolved projectId', () => {
      it('ignores a projectId query param and uses the slug-resolved projectId', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-123');
        mockGovernanceService.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

        await controller.getMemory('my-project', { projectId: 'evil', kind: 'FACT' } as never, agent());

        expect(mockGovernanceService.getProjectMemory).toHaveBeenCalled();
        const calledWith = mockGovernanceService.getProjectMemory.mock.calls[0][0];
        expect(calledWith.projectId).toBe('project-123');
        expect(calledWith.projectId).not.toBe('evil');
      });
    });
  });

  // memory-notes US-006: the incremental export feed. The membership decision and the `memory.read` key are the
  // guard's, exactly as on the list; the handler resolves the slug, builds the owner from the caller and hands
  // the cursor and the page size to the service. The 400s, 403s and 404s themselves are covered over real HTTP
  // by test/integration/memory/memory-export.integration.spec.ts.
  describe('exportMemory (memory-notes US-006)', () => {
    const emptyPage = { items: [], nextCursor: null, hasMore: false };

    beforeEach(() => {
      mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-resolved-id');
      mockGovernanceService.exportProjectMemory.mockResolvedValue(emptyPage);
    });

    it('declares ProjectMembershipGuard, RequiresGuard and the memory.read key on the route', () => {
      const guards = Reflect.getMetadata('__guards__', MemoryReadController.prototype.exportMemory) as unknown[];
      const requires = Reflect.getMetadata('koda:requires', MemoryReadController.prototype.exportMemory) as {
        keys: string[];
        enforcedBy: string;
      };

      expect(guards?.map((guard) => (guard as { name: string }).name)).toEqual([
        'ProjectMembershipGuard',
        'RequiresGuard',
      ]);
      expect(requires).toMatchObject({ keys: ['memory.read'], enforcedBy: 'guard' });
    });

    it('resolves the slug and reads the feed for the caller, never for an owner in the query', async () => {
      await controller.exportMemory(
        'my-project',
        { since: 'abc', take: '250', ownerId: 'someone-else' } as never,
        agent('agent-A'),
      );

      expect(mockGovernanceService.exportProjectMemory).toHaveBeenCalledWith(
        'project-resolved-id',
        { ownerType: 'AGENT', ownerId: 'agent-A' },
        'abc',
        250,
      );
    });

    it('answers the page the service composed, in the JSON envelope', async () => {
      const page = { items: [{ id: 'mem-1' }], nextCursor: 'cursor-1', hasMore: true };
      mockGovernanceService.exportProjectMemory.mockResolvedValue(page);

      const result = await controller.exportMemory('my-project', {} as never, user('user-A'));

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual(page);
    });

    it('defaults take to 100 and passes no since when the query carries neither', async () => {
      await controller.exportMemory('my-project', {} as never, agent());

      expect(mockGovernanceService.exportProjectMemory).toHaveBeenCalledWith(
        'project-resolved-id',
        { ownerType: 'AGENT', ownerId: 'agent-1' },
        undefined,
        100,
      );
    });

    it('answers 404 for an unknown or soft-deleted project and never reads the feed', async () => {
      mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(controller.exportMemory('unknown-slug', {} as never, agent())).rejects.toThrow(NotFoundAppException);

      expect(mockGovernanceService.exportProjectMemory).not.toHaveBeenCalled();
    });
  });
});
