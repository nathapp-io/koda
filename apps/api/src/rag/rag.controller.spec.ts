import { Test, TestingModule } from '@nestjs/testing';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaRagRepository } from './prisma-rag.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import type { ListKbDocumentsQuery } from './dto/list-kb-documents.query';

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  name: 'Alpha',
  key: 'ALP',
  graphifyEnabled: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('RagController', () => {
  let controller: RagController;
  let ragService: jest.Mocked<RagService>;
  let hybridRetrieverService: jest.Mocked<HybridRetrieverService>;

  const mockFindProjectBySlug = jest.fn();
  const mockUpdateGraphifyLastImportedAt = jest.fn();

  // US-005: PrismaRagRepository.findProjectMembership was deleted — membership
  // is ProjectMembershipGuard's job, so the controller's repository stub no
  // longer carries a membership lookup.
  const mockRagRepository: Partial<PrismaRagRepository> = {
    findProjectBySlug: mockFindProjectBySlug,
    updateGraphifyLastImportedAt: mockUpdateGraphifyLastImportedAt,
  };

  beforeEach(async () => {
    ragService = {
      indexDocument: jest.fn(),
      listDocuments: jest.fn(),
      deleteBySource: jest.fn(),
      importGraphify: jest.fn(),
      optimizeTable: jest.fn(),
    } as unknown as jest.Mocked<RagService>;

    hybridRetrieverService = {
      indexDocument: jest.fn(),
      search: jest.fn(),
    } as unknown as jest.Mocked<HybridRetrieverService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RagController],
      providers: [
        { provide: RagService, useValue: ragService },
        { provide: HybridRetrieverService, useValue: hybridRetrieverService },
        { provide: PrismaRagRepository, useValue: mockRagRepository },
        // US-001: the class-level ProjectMembershipGuard is instantiated by the DI
        // container even though these tests call the handlers directly, so its
        // ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
      ],
    }).compile();

    controller = module.get<RagController>(RagController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('addDocument', () => {
    it('indexes only via ragService (single LanceDB write path — H7)', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.indexDocument.mockResolvedValue('doc-record-1');

      const result = await controller.addDocument(
        'alpha',
        {
          source: 'doc',
          sourceId: 'doc-1',
          content: 'hello world',
          metadata: {},
        },
      );

      expect(ragService.indexDocument).toHaveBeenCalledTimes(1);
      expect(ragService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'doc-1' }));
      // H7: HybridRetriever must NOT receive a second, duplicate index write.
      expect(hybridRetrieverService.indexDocument).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ indexed: true, id: 'doc-record-1', sourceId: 'doc-1' });
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.addDocument(
          'missing',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
        ),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });

      await expect(
        controller.addDocument(
          'alpha',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
        ),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('allows agent principal to add a document', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.indexDocument.mockResolvedValue('doc-record-2');

      const result = await controller.addDocument(
        'alpha',
        { source: 'doc', sourceId: 'doc-2', content: 'from agent', metadata: {} },
      );

      expect(ragService.indexDocument).toHaveBeenCalled();
      expect(hybridRetrieverService.indexDocument).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ indexed: true, id: 'doc-record-2', sourceId: 'doc-2' });
    });

    // US-001: the membership gate for this route moved to ProjectMembershipGuard,
    // which runs before the handler. Non-members, project VIEWERs on a write route
    // and members are covered at the HTTP boundary in
    // projects/project-membership.guard.routes.spec.ts.
  });

  describe('listDocuments', () => {
    it('lists documents with default limit 100', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', {} as ListKbDocumentsQuery);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 100);
    });

    it('uses the validated limit', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', { limit: '25' } as unknown as ListKbDocumentsQuery);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 25);
    });

    it('allows agent principal to list documents', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha');

      expect(ragService.listDocuments).toHaveBeenCalled();
    });

    // US-001: the membership gate for this route moved to ProjectMembershipGuard
    // (see projects/project-membership.guard.routes.spec.ts).
  });

  describe('deleteDocument', () => {
    it('deletes by sourceId for admin', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.deleteBySource.mockResolvedValue(undefined);

      const result = await controller.deleteDocument('alpha', 'doc-1');

      expect(ragService.deleteBySource).toHaveBeenCalledWith('proj-1', 'doc-1');
      expect((result as any).data).toEqual({ deleted: true });
    });
  });

  describe('search', () => {
    const mockSearchResult = {
      results: [],
      scores: [],
      retrievedAt: new Date().toISOString(),
    };

    it('allows agent principal to search', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'auth bug', limit: 10 });

      expect(hybridRetrieverService.search).toHaveBeenCalled();
      expect((result as any).data).toBeDefined();
    });

    it('allows admin to search', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      await controller.search('alpha', { query: 'test' });

      expect(hybridRetrieverService.search).toHaveBeenCalled();
    });

    // US-001: the membership gate for this route moved to ProjectMembershipGuard
    // (see projects/project-membership.guard.routes.spec.ts). A project VIEWER is
    // still allowed to search — KB reads permit VIEWER.

    it('allows member with valid project role', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'test' });

      expect((result as any).data.results).toEqual([]);
    });

    it('throws NotFoundAppException for missing project', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.search('missing', { query: 'test' }),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('includes provenance in response', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue({
        results: [
          {
            id: 'r1',
            source: 'ticket',
            sourceId: 'ticket-1',
            content: 'bug fix',
            score: 0.9,
            similarity: 'high',
            metadata: {},
            createdAt: new Date().toISOString(),
            provenance: { indexedAt: new Date().toISOString(), sourceProjectId: 'proj-1' },
            rank: 1,
          },
        ],
        scores: [{ vectorScore: 0.9, lexicalScore: 0.8, entityScore: 0, recencyScore: 0.5, finalScore: 0.9 }],
        retrievedAt: new Date().toISOString(),
      });

      const result = await controller.search('alpha', { query: 'bug' });

      expect((result as any).data.provenance.sources).toHaveLength(1);
      expect((result as any).data.provenance.sources[0]).toEqual({ sourceType: 'ticket', sourceId: 'ticket-1' });
    });
  });

  describe('importGraphify', () => {
    it('returns immediately when nodes array is empty', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: true });

      const result = await controller.importGraphify('alpha', { nodes: [], links: [] });

      expect(ragService.importGraphify).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ imported: 0, cleared: 0 });
    });

    it('throws ValidationAppException when graphify is disabled for project', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: false });

      await expect(
        controller.importGraphify(
          'alpha',
          { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
        ),
      ).rejects.toThrow();
    });

    it('imports nodes and returns the import result (timestamp updated inside service)', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      ragService.importGraphify.mockResolvedValue({ imported: 1, cleared: 0 } as any);

      const result = await controller.importGraphify(
        'alpha',
        { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
      );

      expect(ragService.importGraphify).toHaveBeenCalledWith('proj-1', [{ id: 'n1', label: 'Foo' }], []);
      // graphifyLastImportedAt is now updated inside RagService.importGraphify,
      // not in the controller, so the repository mock is not called here.
      expect(mockUpdateGraphifyLastImportedAt).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ imported: 1, cleared: 0 });
    });
  });

  describe('optimizeTable', () => {
    it('calls ragService.optimizeTable and returns optimized true', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.optimizeTable.mockResolvedValue(undefined);

      const result = await controller.optimizeTable('alpha');

      expect(ragService.optimizeTable).toHaveBeenCalledWith('proj-1');
      expect((result as any).data).toEqual({ optimized: true });
    });
  });
});
