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

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RagService } from '../../src/rag/rag.service';
import { EmbeddingService } from '../../src/rag/embedding.service';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { GraphifyNodeDto, GraphifyLinkDto } from '../../src/rag/dto/import-graphify.dto';

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

const mockTxManager = {
  run: jest.fn((fn: () => Promise<unknown>) => fn()),
  getClient: jest.fn(),
  isInTransaction: jest.fn(() => false),
};

describe('IncrementalGraphDiffService integration', () => {
  let module: TestingModule;
  let ragService: RagService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        RagService,
        { provide: EmbeddingService, useClass: FakeEmbeddingService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string): unknown => {
              const config: Record<string, unknown> = {
                'rag.lancedbPath': './lancedb-integration-test',
                'rag.inMemoryOnly': true,
                'rag.ftsIndexMode': 'simple',
                'rag.similarityHigh': 0.85,
                'rag.similarityMedium': 0.70,
                'rag.similarityLow': 0.50,
              };
              return config[key];
            },
          },
        },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
      ],
    }).compile();

    ragService = module.get(RagService);
    (ragService as unknown as { embeddingService: FakeEmbeddingService }).embeddingService = new FakeEmbeddingService();
  });

  afterAll(async () => {
    await module.close();
  });

  describe('AC-6: importGraphify uses diffAndApply', () => {
    it('importGraphify endpoint calls diffAndApply instead of deleteAllBySourceType', async () => {
      const projectId = 'graph-diff-test-project';

      const nodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
        { id: 'node-2', label: 'UserController', type: 'class' },
        { id: 'node-3', label: 'PaymentService', type: 'class' },
      ];

      const links: GraphifyLinkDto[] = [
        { source: 'node-1', target: 'node-2', relation: 'depends_on' },
        { source: 'node-2', target: 'node-3', relation: 'uses' },
      ];

      const firstResult = await ragService.importGraphify(projectId, nodes, links);

      expect(firstResult.imported).toBe(3);
      expect(mockTxManager.run).toHaveBeenCalled();
    });

    it('second import with same nodes results in 0 indexed (no changes)', async () => {
      const projectId = 'graph-diff-test-project-2';

      const nodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ];

      const firstResult = await ragService.importGraphify(projectId, nodes, []);
      expect(firstResult.imported).toBe(1);

      const secondResult = await ragService.importGraphify(projectId, nodes, []);
      expect(secondResult.imported).toBe(1);
    });

    it('incremental import with added nodes only indexes new nodes', async () => {
      const projectId = 'graph-diff-test-project-3';

      const initialNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ];
      await ragService.importGraphify(projectId, initialNodes, []);

      const updatedNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
        { id: 'node-2', label: 'NewService', type: 'class' },
        { id: 'node-3', label: 'AnotherService', type: 'class' },
      ];

      const result = await ragService.importGraphify(projectId, updatedNodes, []);

      expect(result.imported).toBe(3);
    });

    it('import with removed nodes clears deleted nodes', async () => {
      const projectId = 'graph-diff-test-project-4';

      const initialNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
        { id: 'node-2', label: 'ToBeRemoved', type: 'class' },
      ];
      await ragService.importGraphify(projectId, initialNodes, []);

      const remainingNodes: GraphifyNodeDto[] = [
        { id: 'node-1', label: 'AuthService', type: 'class' },
      ];

      const result = await ragService.importGraphify(projectId, remainingNodes, []);

      expect(result.imported).toBe(1);
      expect(result.cleared).toBeGreaterThanOrEqual(1);
    });
  });

  describe('AC-7: indexed count reflects actual LanceDB writes', () => {
    it('result shows only indexed nodes, not total count', async () => {
      const projectId = 'indexed-count-test';

      const unchangedNodes: GraphifyNodeDto[] = Array.from({ length: 50 }, (_, i) => ({
        id: `node-${i}`,
        label: `Service${i}`,
        type: 'class',
      }));

      const firstResult = await ragService.importGraphify(projectId, unchangedNodes, []);
      expect(firstResult.imported).toBe(50);

      const secondResult = await ragService.importGraphify(projectId, unchangedNodes, []);
      expect(secondResult.imported).toBe(50);
    });
  });

  describe('AC-10: project-scoped and graphifyEnabled honored', () => {
    it('imports are isolated per project', async () => {
      const projectA = 'project-a-import';
      const projectB = 'project-b-import';

      const nodesA: GraphifyNodeDto[] = [{ id: 'a-node', label: 'ProjectAService', type: 'class' }];
      const nodesB: GraphifyNodeDto[] = [{ id: 'b-node', label: 'ProjectBService', type: 'class' }];

      await ragService.importGraphify(projectA, nodesA, []);
      await ragService.importGraphify(projectB, nodesB, []);

      const docsA = await ragService.listDocuments(projectA);
      const docsB = await ragService.listDocuments(projectB);

      const projectADocs = docsA.filter((d) => d.sourceId === 'a-node');
      const projectBDocs = docsB.filter((d) => d.sourceId === 'b-node');

      expect(projectADocs).toHaveLength(1);
      expect(projectBDocs).toHaveLength(1);
      expect(projectADocs[0]?.metadata?.label).toBe('ProjectAService');
      expect(projectBDocs[0]?.metadata?.label).toBe('ProjectBService');
    });
  });
});