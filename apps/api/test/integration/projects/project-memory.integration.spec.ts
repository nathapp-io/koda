/**
 * Integration-style controller tests for GET /projects/:slug/memory.
 *
 * These tests target MemoryReadController (memory module), which is the
 * authoritative handler for this route per the W1 observability spec.
 * ProjectsController.getProjectMemory is the LEGACY handler that must be
 * removed by the implementer to avoid a duplicate-route conflict.
 */
import { ForbiddenAppException, JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import { MemoryReadController } from '../../../src/memory/memory-read.controller';
import type { MemoryItem } from '../../../src/memory/memory-item-repository';
import type { UserPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { ProjectsService } from '../../../src/projects/projects.service';

const makeMemoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: 'FACT',
  subject: 'ticket:123',
  predicate: 'status',
  object: 'IN_PROGRESS',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-02'),
  ...overrides,
});

const mockCurrentUser: UserPrincipal = {
  actorType: 'user',
  id: 'user-123',
  sub: 'user-123',
  role: 'ADMIN',
  email: 'test@example.com',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
};

describe('MemoryReadController (routes via memory module)', () => {
  let controller: MemoryReadController;

  const mockMemoryGovernanceService = {
    getProjectMemory: jest.fn(),
  };

  const mockProjectsService = {
    // MemoryReadController uses findProjectIdBySlug (returns string),
    // NOT findBySlug (returns project object) — this is a deliberate difference
    // from the legacy ProjectsController.getProjectMemory implementation.
    findProjectIdBySlug: jest.fn(),
    assertProjectMembership: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-123');
    mockProjectsService.assertProjectMembership.mockResolvedValue(undefined);
    controller = new MemoryReadController(
      mockMemoryGovernanceService as unknown as MemoryGovernanceService,
      mockProjectsService as unknown as ProjectsService,
    );
  });

  describe('GET /projects/:slug/memory', () => {
    it('AC1: returns items and total for a project with active memory items', async () => {
      const items = [
        makeMemoryItem(),
        makeMemoryItem({
          id: 'mem-2',
          kind: 'DECISION',
          subject: 'deployment:prod',
          predicate: 'approved',
          object: 'true',
        }),
      ];
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 2 });

      const result = await controller.getMemory('koda-test', mockCurrentUser);

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123' }),
      );
      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data.total).toBe(2);
      expect(result.data.items).toHaveLength(2);
    });

    it('AC2: GET /projects/:slug/memory?kind=FACT returns only FACT memories', async () => {
      const factItems = [makeMemoryItem({ kind: 'FACT' })];
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items: factItems, total: 1 });

      const result = await controller.getMemory('koda-test', mockCurrentUser, 'FACT');

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123', kind: 'FACT' }),
      );
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]).toHaveProperty('kind', 'FACT');
    });

    it('AC3: calls service without status when no status param is given (repository defaults to active + non-expired)', async () => {
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

      await controller.getMemory('koda-test', mockCurrentUser);

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalled();
      const calledQuery = mockMemoryGovernanceService.getProjectMemory.mock.calls[0][0];
      expect(calledQuery.status).toBeUndefined();
    });

    it('AC4: GET /projects/:slug/memory?status=superseded returns superseded memories', async () => {
      const supersededItems = [
        makeMemoryItem({
          id: 'mem-old',
          status: 'superseded',
          supersededBy: 'mem-new',
        }),
      ];
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items: supersededItems, total: 1 });

      const result = await controller.getMemory('koda-test', mockCurrentUser, undefined, undefined, 'superseded');

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123', status: 'superseded' }),
      );
      expect(result.data.items[0]).toHaveProperty('supersededBy', 'mem-new');
    });

    it('AC5: pagination — passes page and limit as numbers to the service', async () => {
      const page2Items = Array.from({ length: 5 }, (_, i) => makeMemoryItem({ id: `mem-${i + 11}` }));
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items: page2Items, total: 15 });

      const result = await controller.getMemory('koda-test', mockCurrentUser, undefined, undefined, undefined, '2', '10');

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 10 }),
      );
      expect(result.data.items).toHaveLength(5);
    });

    it('AC6: subject filter — passes subject to service when subject param is given', async () => {
      const items = [makeMemoryItem({ subject: 'ticket:123' })];
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items, total: 1 });

      const result = await controller.getMemory('koda-test', mockCurrentUser, undefined, 'ticket:123');

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123', subject: 'ticket:123' }),
      );
      expect(result.data.items[0]).toHaveProperty('subject', 'ticket:123');
    });

    it('AC7: returns 404 when project slug does not resolve', async () => {
      mockProjectsService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(controller.getMemory('nonexistent', mockCurrentUser)).rejects.toThrow(NotFoundAppException);
    });

    it('AC8: returns 403 for a principal who is not a member of the project', async () => {
      mockProjectsService.assertProjectMembership.mockRejectedValue(
        new ForbiddenAppException({}, 'projects'),
      );

      await expect(controller.getMemory('koda-test', mockCurrentUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('project isolation: uses the projectId from the resolved slug, not a hardcoded value', async () => {
      mockProjectsService.findProjectIdBySlug.mockResolvedValue('project-456');
      mockMemoryGovernanceService.getProjectMemory.mockResolvedValue({ items: [], total: 0 });

      await controller.getMemory('other-project', mockCurrentUser);

      expect(mockMemoryGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-456' }),
      );
      expect(mockMemoryGovernanceService.getProjectMemory).not.toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123' }),
      );
    });
  });
});
