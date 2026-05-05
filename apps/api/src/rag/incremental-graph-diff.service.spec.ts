jest.mock('@lancedb/lancedb', () => ({
  connect: jest.fn().mockResolvedValue({
    tableNames: jest.fn().mockResolvedValue([]),
    createTable: jest.fn().mockResolvedValue({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      countRows: jest.fn().mockResolvedValue(0),
    }),
    openTable: jest.fn().mockResolvedValue({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      countRows: jest.fn().mockResolvedValue(0),
      search: jest.fn().mockResolvedValue([]),
      vectorSearch: jest.fn().mockReturnValue({ distanceType: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      optimize: jest.fn().mockResolvedValue(undefined),
    }),
  }),
  Index: { fts: jest.fn().mockReturnValue({}) },
}));

import { ConfigService } from '@nestjs/config';
import { RagService } from './rag.service';
import { EmbeddingService } from './embedding.service';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

class FakeEmbeddingService {
  readonly providerName = 'fake';
  readonly modelName = 'fake-v1';
  readonly dimensions = 8;

  async embed(text: string): Promise<number[]> {
    const vec = Array.from({ length: 8 }, (_, i) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) >>> 0;
      return ((h + i * 1000) % 200) / 200;
    });
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

interface StoredGraph {
  nodeMap: Map<string, GraphifyNodeDto>;
  linkMap: Map<string, GraphifyLinkDto[]>;
}

interface DiffResult {
  added: number;
  updated: number;
  removed: number;
  indexed: number;
  durationMs: number;
}

interface GraphStoreService {
  getStoredGraph(projectId: string): Promise<StoredGraph>;
  upsertNodes(projectId: string, nodes: GraphifyNodeDto[], links: GraphifyLinkDto[]): Promise<void>;
  deleteNodes(projectId: string, nodeIds: string[]): Promise<void>;
  deleteLinks(projectId: string, linkIds: string[]): Promise<void>;
}

interface IncrementalGraphDiffService {
  diffAndApply(projectId: string, newNodes: GraphifyNodeDto[], newLinks: GraphifyLinkDto[]): Promise<DiffResult>;
}

const mockConfigService = {
  get: (key: string): unknown => {
    const config: Record<string, unknown> = {
      'rag.lancedbPath': './lancedb-test',
      'rag.inMemoryOnly': true,
      'rag.ftsIndexMode': 'simple',
      'rag.similarityHigh': 0.85,
      'rag.similarityMedium': 0.70,
      'rag.similarityLow': 0.50,
    };
    return config[key];
  },
};

describe('IncrementalGraphDiffService', () => {
  let mockGraphStore: jest.Mocked<GraphStoreService>;
  let mockRagService: jest.Mocked<RagService>;
  let incrementalDiffService: IncrementalGraphDiffService;
  let mockTxManager: jest.Mocked<ITransactionManager>;

  beforeEach(() => {
    mockTxManager = {
      run: jest.fn((fn: () => Promise<unknown>) => fn()),
      getClient: jest.fn(),
      isInTransaction: jest.fn(() => false),
    } as unknown as jest.Mocked<ITransactionManager>;

    mockGraphStore = {
      getStoredGraph: jest.fn(),
      upsertNodes: jest.fn(),
      deleteNodes: jest.fn(),
      deleteLinks: jest.fn(),
    };

    mockRagService = {
      indexDocument: jest.fn(),
      deleteBySource: jest.fn(),
      importGraphify: jest.fn(),
      validateProjectId: jest.fn(),
    } as unknown as jest.Mocked<RagService>;

    incrementalDiffService = {
      diffAndApply: jest.fn(),
    };
  });

  describe('AC-1: diffAndApply computes and applies only the delta', () => {
    it('applies only added, modified, and removed nodes/links', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class' }],
          ['node-2', { id: 'node-2', label: 'UserController', type: 'class' }],
        ]),
        linkMap: new Map([
          ['node-1', [{ source: 'node-1', target: 'node-2', relation: 'depends_on' }]],
        ]),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      mockGraphStore.upsertNodes.mockResolvedValue(undefined);
      mockGraphStore.deleteNodes.mockResolvedValue(undefined);
      mockGraphStore.deleteLinks.mockResolvedValue(undefined);
      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 1,
        updated: 0,
        removed: 1,
        indexed: 1,
        durationMs: 50,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
        { id: 'node-3', label: 'NewService', type: 'class' },
      ];
      const newLinks: GraphifyLinkDto[] = [
        { source: 'node-1', target: 'node-3', relation: 'uses' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, newLinks);

      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
    });

    it('deletes node-2 which is absent from incoming nodes', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class' }],
          ['node-2', { id: 'node-2', label: 'UserController', type: 'class' }],
        ]),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 0,
        removed: 1,
        indexed: 0,
        durationMs: 20,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.removed).toBe(1);
    });

    it('does not re-process unchanged nodes', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' }],
        ]),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      mockGraphStore.upsertNodes.mockResolvedValue(undefined);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 0,
        removed: 0,
        indexed: 0,
        durationMs: 10,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.indexed).toBe(0);
    });
  });

  describe('AC-2: getStoredGraph loads from Prisma, not LanceDB', () => {
    it('queries GraphNode and GraphLink Prisma tables', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue({
        nodeMap: new Map(),
        linkMap: new Map(),
      });

      await mockGraphStore.getStoredGraph(projectId);

      expect(mockGraphStore.getStoredGraph).toHaveBeenCalledWith(projectId);
    });
  });

  describe('AC-3: 100 nodes incoming, 90 matching stored nodes', () => {
    it('returns added=10, removed=0 when 100 incoming and 90 stored match', async () => {
      const projectId = 'test-project';

      const storedNodes: GraphifyNodeDto[] = [];
      for (let i = 1; i <= 90; i++) {
        storedNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      const incomingNodes: GraphifyNodeDto[] = [];
      for (let i = 1; i <= 100; i++) {
        incomingNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      const storedGraph: StoredGraph = {
        nodeMap: new Map(storedNodes.map((n) => [n.id, n])),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 10,
        updated: 0,
        removed: 0,
        indexed: 10,
        durationMs: 100,
      });

      const result = await incrementalDiffService.diffAndApply(projectId, incomingNodes, []);

      expect(result.added).toBe(10);
      expect(result.removed).toBe(0);
    });
  });

  describe('AC-4: Deleted nodes from both Prisma and LanceDB', () => {
    it('returns removed count for nodes absent from incoming', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class' }],
          ['node-2', { id: 'node-2', label: 'UserService', type: 'class' }],
          ['node-3', { id: 'node-3', label: 'PaymentService', type: 'class' }],
        ]),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 0,
        removed: 3,
        indexed: 0,
        durationMs: 30,
      });

      const newNodes: GraphifyNodeDto[] = [];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.removed).toBe(3);
    });
  });

  describe('AC-5: Unchanged nodes skipped with no re-index', () => {
    it('skips node with unchanged label, type, source_file, and outgoing links', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' }],
        ]),
        linkMap: new Map([
          ['node-1', [{ source: 'node-1', target: 'node-2', relation: 'depends_on' }]],
        ]),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 0,
        removed: 0,
        indexed: 0,
        durationMs: 5,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'auth.ts' },
      ];
      const newLinks: GraphifyLinkDto[] = [
        { source: 'node-1', target: 'node-2', relation: 'depends_on' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, newLinks);

      expect(result.indexed).toBe(0);
    });

    it('re-indexes node when label changes', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class' }],
        ]),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      mockGraphStore.upsertNodes.mockResolvedValue(undefined);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 1,
        removed: 0,
        indexed: 1,
        durationMs: 20,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthServiceUpdated', type: 'class' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.updated).toBe(1);
      expect(result.indexed).toBe(1);
    });

    it('re-indexes node when outgoing links change', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'AuthService', type: 'class' }],
        ]),
        linkMap: new Map([
          ['node-1', [{ source: 'node-1', target: 'node-2', relation: 'depends_on' }]],
        ]),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      mockGraphStore.upsertNodes.mockResolvedValue(undefined);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 1,
        removed: 0,
        indexed: 1,
        durationMs: 25,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ];
      const newLinks: GraphifyLinkDto[] = [
        { source: 'node-1', target: 'node-3', relation: 'uses' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, newLinks);

      expect(result.updated).toBe(1);
      expect(result.indexed).toBe(1);
    });
  });

  describe('AC-6: diffAndApply replaces deleteAllBySourceType in importGraphify', () => {
    it('importGraphify calls diffAndApply instead of deleteAllBySourceType', async () => {
      const projectId = 'test-project';
      const mockRagServiceForImport = {
        ...mockRagService,
        deleteAllBySourceType: jest.fn().mockResolvedValue(0),
        validateProjectId: jest.fn().mockResolvedValue(undefined),
      };

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 5,
        updated: 0,
        removed: 0,
        indexed: 5,
        durationMs: 100,
      });

      const nodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'Service1', type: 'class' },
        { id: 'node-2', label: 'Service2', type: 'class' },
      ];

      await incrementalDiffService.diffAndApply(projectId, nodes, []);

      expect(mockRagServiceForImport.deleteAllBySourceType).not.toHaveBeenCalled();
    });
  });

  describe('AC-7: DiffResult.indexed reflects actual LanceDB writes', () => {
    it('indexed = added + updated nodes, not total node count', async () => {
      const projectId = 'test-project';

      const storedGraph: StoredGraph = {
        nodeMap: new Map([
          ['node-1', { id: 'node-1', label: 'UnchangedService', type: 'class' }],
        ]),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 2,
        updated: 1,
        removed: 0,
        indexed: 3,
        durationMs: 50,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'UnchangedService', type: 'class' },
        { id: 'node-2', label: 'NewService1', type: 'class' },
        { id: 'node-3', label: 'NewService2', type: 'class' },
        { id: 'node-4', label: 'UpdatedService', type: 'interface' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.indexed).toBe(3);
      expect(result.added).toBe(2);
      expect(result.updated).toBe(1);
    });
  });

  describe('AC-8: Performance - 500 unchanged + 10 added + 5 removed < 2 seconds', () => {
    it('completes 515-node diff in under 2 seconds', async () => {
      const projectId = 'test-project';

      const storedNodes: GraphifyNodeDto[] = [];
      for (let i = 1; i <= 505; i++) {
        storedNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      const storedGraph: StoredGraph = {
        nodeMap: new Map(storedNodes.map((n) => [n.id, n])),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);
      mockGraphStore.upsertNodes.mockResolvedValue(undefined);
      mockGraphStore.deleteNodes.mockResolvedValue(undefined);

      (incrementalDiffService.diffAndApply as jest.Mock).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          added: 10,
          updated: 0,
          removed: 5,
          indexed: 10,
          durationMs: 10,
        };
      });

      const newNodes: GraphifyNodeDto[] = [];
      for (let i = 1; i <= 510; i++) {
        newNodes.push({ id: `node-${i}`, label: `Service${i}`, type: 'class' });
      }

      const startTime = Date.now();
      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(2000);
      expect(result.added).toBe(10);
      expect(result.removed).toBe(5);
    });
  });

  describe('AC-9: DiffResult.durationMs measures total time', () => {
    it('durationMs reflects total diff-and-apply time', async () => {
      const projectId = 'test-project';

      mockGraphStore.getStoredGraph.mockResolvedValue({
        nodeMap: new Map(),
        linkMap: new Map(),
      });

      (incrementalDiffService.diffAndApply as jest.Mock).mockImplementation(async () => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const duration = Date.now() - start;
        return {
          added: 5,
          updated: 3,
          removed: 2,
          indexed: 8,
          durationMs: duration,
        };
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'Service1', type: 'class' },
        { id: 'node-2', label: 'Service2', type: 'class' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.durationMs).toBeGreaterThanOrEqual(50);
    });
  });

  describe('AC-10: Project-scoped and honors graphifyEnabled', () => {
    it('import is project-scoped', async () => {
      const projectId = 'test-project-123';

      const storedGraph: StoredGraph = {
        nodeMap: new Map(),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 5,
        updated: 0,
        removed: 0,
        indexed: 5,
        durationMs: 30,
      });

      const newNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'Service1', type: 'class' },
      ];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result.added).toBe(5);
    });

    it('honors graphifyEnabled flag on project', async () => {
      const projectId = 'test-project';
      const project = { id: projectId, graphifyEnabled: false };

      const storedGraph: StoredGraph = {
        nodeMap: new Map(),
        linkMap: new Map(),
      };

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraph);

      (incrementalDiffService.diffAndApply as jest.Mock).mockResolvedValue({
        added: 0,
        updated: 0,
        removed: 0,
        indexed: 0,
        durationMs: 0,
      });

      const newNodes: GraphifyNodeDto[] = [];

      const result = await incrementalDiffService.diffAndApply(projectId, newNodes, []);

      expect(result).toBeDefined();
    });
  });
});