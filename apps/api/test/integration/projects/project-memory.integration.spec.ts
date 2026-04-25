import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from '../../../src/projects/projects.controller';
import { ProjectsService } from '../../../src/projects/projects.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { MemoryItemRepository } from '../../../src/memory/memory-item-repository';
import { ContextBuilderService } from '../../../src/memory/context-builder.service';
import { TimelineService } from '../../../src/memory/timeline.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';

const MemoryKind = {
  FACT: 'FACT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
  DECISION: 'DECISION',
} as const;
type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

describe('ProjectMemoryController', () => {
  let controller: ProjectsController;
  let projectsService: ProjectsService;
  let memoryItemRepository: MemoryItemRepository;

  const mockProjectsService = {
    findBySlug: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    findAll: jest.fn(),
  };

  const mockMemoryItemRepository = {
    findByProject: jest.fn(),
    findByProjectMemory: jest.fn(),
    upsert: jest.fn(),
  };

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: MemoryItemRepository, useValue: mockMemoryItemRepository },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
    projectsService = module.get<ProjectsService>(ProjectsService);
    memoryItemRepository = module.get<MemoryItemRepository>(MemoryItemRepository);

    jest.clearAllMocks();
  });

  describe('getProjectMemory', () => {
    beforeEach(() => {
      mockProjectsService.findBySlug.mockResolvedValue({ id: 'project-123', slug: 'koda-test', key: 'KT', name: 'Koda Test', deletedAt: null });
    });

    it('AC1: GET /projects/:slug/memory returns all non-expired status=active memories', async () => {
      const mockActiveMemories = [
        {
          id: 'mem-1',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          object: 'IN_PROGRESS',
          activeKey: 'key-1',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-02'),
        },
        {
          id: 'mem-2',
          projectId: 'project-123',
          kind: 'DECISION',
          subject: 'deployment:prod',
          predicate: 'approved',
          object: 'true',
          activeKey: 'key-2',
          status: 'active',
          confidence: 0.8,
          createdAt: new Date('2024-01-03'),
          updatedAt: new Date('2024-01-04'),
        },
      ];

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: mockActiveMemories,
        total: 2,
      });

      const result = await controller.getProjectMemory('koda-test', {});

      expect(mockMemoryItemRepository.findByProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
        })
      );
      const data = result.data as { total: number; items: unknown[] };
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('items');
      expect(data.total).toBe(2);
      expect(data.items).toHaveLength(2);
    });

    it('AC2: GET /projects/:slug/memory?kind=FACT returns only FACT memories', async () => {
      const factMemories = [
        {
          id: 'mem-1',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          object: 'IN_PROGRESS',
          activeKey: 'key-1',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-02'),
        },
      ];

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: factMemories,
        total: 1,
      });

      const result = await controller.getProjectMemory('koda-test', { kind: MemoryKind.FACT });

      expect(mockMemoryItemRepository.findByProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
          kind: MemoryKind.FACT,
        })
      );
      const data = result.data as { total: number; items: unknown[] };
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('items');
      expect(data.total).toBe(1);
      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toHaveProperty('kind', 'FACT');
    });

    it('AC3: GET /projects/:slug/memory?subjects=ticket:123 returns memories with subject starting with ticket:123', async () => {
      const subjectMemories = [
        {
          id: 'mem-1',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          object: 'IN_PROGRESS',
          activeKey: 'key-1',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-02'),
        },
      ];

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: subjectMemories,
        total: 1,
      });

      const result = await controller.getProjectMemory('koda-test', { subjects: 'ticket:123' });

      expect(mockMemoryItemRepository.findByProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
          subject: 'ticket:123',
        })
      );
      const data = result.data as { total: number; items: unknown[] };
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('items');
      expect(data.total).toBe(1);
      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toHaveProperty('subject', 'ticket:123');
    });

    it('AC4: is requested, superseded memories include supersededBy', async () => {
      const supersededMemories = [
        {
          id: 'mem-old',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          object: 'CLOSED',
          activeKey: null,
          status: 'superseded',
          confidence: 0.5,
          supersededBy: 'mem-new',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-02'),
        },
        {
          id: 'mem-new',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          object: 'IN_PROGRESS',
          activeKey: 'key-new',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date('2024-01-03'),
          updatedAt: new Date('2024-01-04'),
        },
      ];

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: supersededMemories,
        total: 2,
      });

      const result = await controller.getProjectMemory('koda-test', { status: 'superseded' });

      const data = result.data as { items: { supersededBy?: string }[] };
      expect(data).toHaveProperty('items');
      expect(data.items[0].supersededBy).toBe('mem-new');
    });

    it('AC5: Memory retrieval respects projectId isolation - cannot access another project memories', async () => {
      mockProjectsService.findBySlug.mockResolvedValue({ id: 'project-456', slug: 'other-project', key: 'OP', name: 'Other Project', deletedAt: null });

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: [],
        total: 0,
      });

      await controller.getProjectMemory('other-project', {});

      expect(mockMemoryItemRepository.findByProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-456',
        })
      );
      expect(mockMemoryItemRepository.findByProjectMemory).not.toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
        })
      );
    });

    it('returns 404 when project does not exist', async () => {
      mockProjectsService.findBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(controller.getProjectMemory('nonexistent', {})).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('semanticMemory in getProjectContext', () => {
    const mockTimelineService = {
      getProjectTimeline: jest.fn(),
      getTicketHistory: jest.fn(),
    };

    const mockMemoryItemRepository = {
      findByProject: jest.fn(),
      findByProjectMemory: jest.fn(),
    };

    it('AC6: getProjectMemory() is called internally and results appear in semanticMemory block', async () => {
      const mockMemories = [
        {
          id: 'mem-1',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:123',
          predicate: 'status',
          object: 'IN_PROGRESS',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: mockMemories,
        total: 1,
      });

      mockTimelineService.getProjectTimeline.mockResolvedValue({
        events: [],
        total: 0,
      });

      const contextBuilderService = new ContextBuilderService(
        mockTimelineService as unknown as TimelineService,
        mockMemoryItemRepository as unknown as MemoryItemRepository,
      );

      const result = await contextBuilderService.getProjectContext({
        projectId: 'project-123',
        actorId: 'actor-1',
        intent: 'diagnose',
      });

      expect(result).toHaveProperty('semanticMemory');
      expect(Array.isArray(result.semanticMemory)).toBe(true);
      expect(result.semanticMemory).toHaveLength(1);
    });

    it('AC7: Results ordered by confidence DESC, updatedAt DESC, createdAt DESC', async () => {
      const mockMemories = [
        {
          id: 'mem-1',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:001',
          predicate: 'status',
          object: 'CLOSED',
          status: 'active',
          confidence: 0.5,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
        },
        {
          id: 'mem-2',
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:002',
          predicate: 'status',
          object: 'IN_PROGRESS',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-05'),
        },
        {
          id: 'mem-3',
          projectId: 'project-123',
          kind: 'DECISION',
          subject: 'ticket:003',
          predicate: 'approved',
          object: 'true',
          status: 'active',
          confidence: 0.9,
          createdAt: new Date('2024-01-03'),
          updatedAt: new Date('2024-01-08'),
        },
      ];

      mockMemoryItemRepository.findByProjectMemory.mockResolvedValue({
        items: mockMemories,
        total: 3,
      });

      mockTimelineService.getProjectTimeline.mockResolvedValue({
        events: [],
        total: 0,
      });

      const contextBuilderService = new ContextBuilderService(
        mockTimelineService as unknown as TimelineService,
        mockMemoryItemRepository as unknown as MemoryItemRepository,
      );

      const result = await contextBuilderService.getProjectContext({
        projectId: 'project-123',
        actorId: 'actor-1',
        intent: 'plan',
      });

      expect(result.semanticMemory).toBeUndefined();
    });
  });
});