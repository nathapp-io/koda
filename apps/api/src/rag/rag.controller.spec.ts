import { Test, TestingModule } from '@nestjs/testing';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { EvaluationService } from '../retrieval/evaluation.service';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';

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
  let evaluationService: jest.Mocked<EvaluationService>;

  const mockProjectFindUnique = jest.fn();
  const mockProjectMemberFindUnique = jest.fn();
  const mockProjectUpdate = jest.fn();
  const mockTransaction = jest.fn();

  const mockPrismaClient = {
    project: { findUnique: mockProjectFindUnique, update: mockProjectUpdate },
    projectMember: { findUnique: mockProjectMemberFindUnique },
    $transaction: mockTransaction,
  };

  const mockPrismaService = {
    client: mockPrismaClient,
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

    evaluationService = {
      runQueries: jest.fn(),
    } as unknown as jest.Mocked<EvaluationService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RagController],
      providers: [
        { provide: RagService, useValue: ragService },
        { provide: HybridRetrieverService, useValue: hybridRetrieverService },
        { provide: EvaluationService, useValue: evaluationService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    controller = module.get<RagController>(RagController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('addDocument', () => {
    it('indexes in both ragService and hybridRetrieverService', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      ragService.indexDocument.mockResolvedValue(undefined);
      hybridRetrieverService.indexDocument.mockResolvedValue(undefined);

      const result = await controller.addDocument('alpha', {
        source: 'doc',
        sourceId: 'doc-1',
        content: 'hello world',
        metadata: {},
      });

      expect(ragService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'doc-1' }));
      expect(hybridRetrieverService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'doc-1' }));
      expect((result as any).data).toEqual({ indexed: true });
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockProjectFindUnique.mockResolvedValue(null);

      await expect(
        controller.addDocument('missing', { source: 'doc', sourceId: 'x', content: 'y', metadata: {} }),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockProjectFindUnique.mockResolvedValue({ ...mockProject, deletedAt: new Date() });

      await expect(
        controller.addDocument('alpha', { source: 'doc', sourceId: 'x', content: 'y', metadata: {} }),
      ).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('listDocuments', () => {
    it('lists documents with default limit 100', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha');

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 100);
    });

    it('respects provided limit capped at 500', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', '1000');

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 500);
    });

    it('uses provided limit when below cap', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', '25');

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 25);
    });
  });

  describe('deleteDocument', () => {
    it('deletes by sourceId for admin', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
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
      mockProjectFindUnique.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'auth bug', limit: 10 }, mockAgentPrincipal);

      expect(hybridRetrieverService.search).toHaveBeenCalled();
      expect((result as any).data).toBeDefined();
    });

    it('allows admin to search without membership check', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      await controller.search('alpha', { query: 'test' }, mockAdminUser);

      expect(mockProjectMemberFindUnique).not.toHaveBeenCalled();
    });

    it('forbids user without membership', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      mockProjectMemberFindUnique.mockResolvedValue(null);

      await expect(
        controller.search('alpha', { query: 'test' }, mockMemberUser),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('allows member with valid project role', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'test' }, mockMemberUser);

      expect((result as any).data.results).toEqual([]);
    });

    it('throws NotFoundAppException for missing project', async () => {
      mockProjectFindUnique.mockResolvedValue(null);

      await expect(
        controller.search('missing', { query: 'test' }, mockAdminUser),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('includes provenance in response', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
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
      mockProjectFindUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'DEVELOPER' });

      const result = await controller.importGraphify('alpha', { nodes: [], links: [] }, mockAdminUser);

      expect(ragService.importGraphify).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ imported: 0, cleared: 0 });
    });

    it('throws ValidationAppException when graphify is disabled for project', async () => {
      mockProjectFindUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: false });
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'ADMIN' });

      await expect(
        controller.importGraphify(
          'alpha',
          { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
          mockAdminUser,
        ),
      ).rejects.toThrow();
    });

    it('imports nodes and updates graphifyLastImportedAt', async () => {
      mockProjectFindUnique.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      mockProjectMemberFindUnique.mockResolvedValue({ role: 'ADMIN' });
      ragService.importGraphify.mockResolvedValue({ imported: 1, cleared: 0 } as any);
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({ project: { update: mockProjectUpdate } });
      });

      const result = await controller.importGraphify(
        'alpha',
        { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
        mockAdminUser,
      );

      expect(ragService.importGraphify).toHaveBeenCalledWith('proj-1', [{ id: 'n1', label: 'Foo' }], []);
      expect((result as any).data).toEqual({ imported: 1, cleared: 0 });
    });
  });

  describe('optimizeTable', () => {
    it('calls ragService.optimizeTable and returns optimized true', async () => {
      mockProjectFindUnique.mockResolvedValue(mockProject);
      ragService.optimizeTable.mockResolvedValue(undefined);

      const result = await controller.optimizeTable('alpha', mockAdminUser);

      expect(ragService.optimizeTable).toHaveBeenCalledWith('proj-1');
      expect((result as any).data).toEqual({ optimized: true });
    });
  });
});
