import { Test, TestingModule } from '@nestjs/testing';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaRagRepository } from './prisma-rag.repository';

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

const mockAdminUser = {
  actorType: 'user' as const,
  id: 'user-admin',
  name: 'admin@example.com',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
  extra: { sub: 'user-admin' },
};

const mockMemberUser = {
  actorType: 'user' as const,
  id: 'user-member',
  name: 'member@example.com',
  email: 'member@example.com',
  role: 'MEMBER' as const,
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
  extra: { sub: 'user-member' },
};

const mockAgentPrincipal = {
  actorType: 'agent' as const,
  id: 'agent-1',
  name: 'bot',
  slug: 'bot',
  status: 'ACTIVE' as const,
  agentRoles: ['DEVELOPER'] as const,
  capabilities: [],
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};

describe('RagController', () => {
  let controller: RagController;
  let ragService: jest.Mocked<RagService>;
  let hybridRetrieverService: jest.Mocked<HybridRetrieverService>;

  const mockFindProjectBySlug = jest.fn();
  const mockFindProjectMembership = jest.fn();
  const mockUpdateGraphifyLastImportedAt = jest.fn();

  const mockRagRepository: Partial<PrismaRagRepository> = {
    findProjectBySlug: mockFindProjectBySlug,
    findProjectMembership: mockFindProjectMembership,
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
      ],
    }).compile();

    controller = module.get<RagController>(RagController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('addDocument', () => {
    it('indexes in both ragService and hybridRetrieverService', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.indexDocument.mockResolvedValue(undefined);
      hybridRetrieverService.indexDocument.mockResolvedValue(undefined);

      const result = await controller.addDocument(
        'alpha',
        {
          source: 'doc',
          sourceId: 'doc-1',
          content: 'hello world',
          metadata: {},
        },
        mockAdminUser,
      );

      expect(ragService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'doc-1' }));
      expect(hybridRetrieverService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'doc-1' }));
      expect((result as any).data).toEqual({ indexed: true });
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.addDocument(
          'missing',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
          mockAdminUser,
        ),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });

      await expect(
        controller.addDocument(
          'alpha',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
          mockAdminUser,
        ),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('allows agent principal to add a document', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.indexDocument.mockResolvedValue(undefined);
      hybridRetrieverService.indexDocument.mockResolvedValue(undefined);

      const result = await controller.addDocument(
        'alpha',
        { source: 'doc', sourceId: 'doc-2', content: 'from agent', metadata: {} },
        mockAgentPrincipal,
      );

      expect(mockFindProjectMembership).not.toHaveBeenCalled();
      expect(ragService.indexDocument).toHaveBeenCalled();
      expect((result as any).data).toEqual({ indexed: true });
    });

    it('forbids user without project membership', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      mockFindProjectMembership.mockResolvedValue(null);

      await expect(
        controller.addDocument(
          'alpha',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
          mockMemberUser,
        ),
      ).rejects.toThrow(ForbiddenAppException);
      expect(ragService.indexDocument).not.toHaveBeenCalled();
      expect(hybridRetrieverService.indexDocument).not.toHaveBeenCalled();
    });
  });

  describe('listDocuments', () => {
    it('lists documents with default limit 100', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', mockAdminUser);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 100);
    });

    it('respects provided limit capped at 500', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', mockAdminUser, '1000');

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 500);
    });

    it('uses provided limit when below cap', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', mockAdminUser, '25');

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 25);
    });

    it('allows agent principal to list documents', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', mockAgentPrincipal);

      expect(mockFindProjectMembership).not.toHaveBeenCalled();
      expect(ragService.listDocuments).toHaveBeenCalled();
    });

    it('forbids user without project membership', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      mockFindProjectMembership.mockResolvedValue(null);

      await expect(
        controller.listDocuments('alpha', mockMemberUser),
      ).rejects.toThrow(ForbiddenAppException);
      expect(ragService.listDocuments).not.toHaveBeenCalled();
    });
  });

  describe('deleteDocument', () => {
    it('deletes by sourceId for admin', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.deleteBySource.mockResolvedValue(undefined);

      const result = await controller.deleteDocument('alpha', 'doc-1', mockAdminUser);

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

      const result = await controller.search('alpha', { query: 'auth bug', limit: 10 }, mockAgentPrincipal);

      expect(hybridRetrieverService.search).toHaveBeenCalled();
      expect((result as any).data).toBeDefined();
    });

    it('allows admin to search without membership check', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      await controller.search('alpha', { query: 'test' }, mockAdminUser);

      expect(mockFindProjectMembership).not.toHaveBeenCalled();
    });

    it('forbids user without membership', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      mockFindProjectMembership.mockResolvedValue(null);

      await expect(
        controller.search('alpha', { query: 'test' }, mockMemberUser),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('allows member with valid project role', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      mockFindProjectMembership.mockResolvedValue({ role: 'DEVELOPER' });
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'test' }, mockMemberUser);

      expect((result as any).data.results).toEqual([]);
    });

    it('throws NotFoundAppException for missing project', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.search('missing', { query: 'test' }, mockAdminUser),
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

      const result = await controller.search('alpha', { query: 'bug' }, mockAdminUser);

      expect((result as any).data.provenance.sources).toHaveLength(1);
      expect((result as any).data.provenance.sources[0]).toEqual({ sourceType: 'ticket', sourceId: 'ticket-1' });
    });
  });

  describe('importGraphify', () => {
    it('returns immediately when nodes array is empty', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockFindProjectMembership.mockResolvedValue({ role: 'DEVELOPER' });

      const result = await controller.importGraphify('alpha', { nodes: [], links: [] }, mockAdminUser);

      expect(ragService.importGraphify).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ imported: 0, cleared: 0 });
    });

    it('throws ValidationAppException when graphify is disabled for project', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: false });
      mockFindProjectMembership.mockResolvedValue({ role: 'ADMIN' });

      await expect(
        controller.importGraphify(
          'alpha',
          { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
          mockAdminUser,
        ),
      ).rejects.toThrow();
    });

    it('imports nodes and returns the import result (timestamp updated inside service)', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockFindProjectMembership.mockResolvedValue({ role: 'ADMIN' });
      ragService.importGraphify.mockResolvedValue({ imported: 1, cleared: 0 } as any);

      const result = await controller.importGraphify(
        'alpha',
        { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
        mockAdminUser,
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

      const result = await controller.optimizeTable('alpha', mockAdminUser);

      expect(ragService.optimizeTable).toHaveBeenCalledWith('proj-1');
      expect((result as any).data).toEqual({ optimized: true });
    });
  });
});
