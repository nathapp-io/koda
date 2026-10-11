import type { Mock } from 'vitest';
vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn().mockResolvedValue({
    tableNames: vi.fn().mockResolvedValue([]),
    createTable: vi.fn().mockResolvedValue({
      delete: vi.fn().mockResolvedValue(undefined),
      createIndex: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
      countRows: vi.fn().mockResolvedValue(0),
    }),
    openTable: vi.fn().mockResolvedValue({
      delete: vi.fn().mockResolvedValue(undefined),
      createIndex: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
      countRows: vi.fn().mockResolvedValue(0),
      search: vi.fn().mockResolvedValue([]),
      vectorSearch: vi.fn().mockReturnValue({ distanceType: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
      optimize: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  Index: { fts: vi.fn().mockReturnValue({}) },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { RAG_CFG } from '../../../src/config/rag.config';
import { RagService } from '../../../src/rag/rag.service';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { IncrementalGraphDiffService } from '../../../src/rag/incremental-graph-diff.service';
import { GraphStoreService, StoredGraph } from '../../../src/rag/graph-store.service';
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { GraphifyNodeDto, GraphifyLinkDto } from '../../../src/rag/dto/import-graphify.dto';

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

const storedGraphEmpty: StoredGraph = {
  nodeMap: new Map(),
  linkMap: new Map(),
};

const mockGraphStore = {
  getStoredGraph: vi.fn().mockResolvedValue(storedGraphEmpty),
  applyDiff: vi.fn().mockResolvedValue(undefined),
  markVectorStale: vi.fn().mockResolvedValue(undefined),
  findVectorStaleNodeIds: vi.fn().mockResolvedValue([]),
  clearVectorStale: vi.fn().mockResolvedValue(undefined),
};

const mockTxManager = {
  run: vi.fn((fn: () => Promise<unknown>) => fn()),
  getClient: vi.fn(),
  isInTransaction: vi.fn(() => false),
};

const mockRagConfig = {
  embeddingProvider: 'ollama',
  embeddingModel: 'nomic-embed-text',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiApiKey: '',
  lancedbPath: './lancedb-wiring-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.70,
  similarityLow: 0.50,
  ftsOptimizeStrategy: 'counter',
  ftsOptimizeThreshold: 100,
  ftsOptimizeIntervalMs: 60000,
  graphifyEnabledCacheTtlSec: 60,
};

describe('IncrementalGraphDiffService wiring (SRC-001)', () => {
  let module: TestingModule;
  let ragService: RagService;
  let diffAndApplyMock: Mock;

  beforeAll(async () => {
    diffAndApplyMock = vi.fn().mockResolvedValue({
      added: 2,
      updated: 0,
      removed: 1,
      indexed: 2,
      durationMs: 50,
    });

    module = await Test.createTestingModule({
      providers: [
        RagService,
        VectorStore,
        {
          provide: IncrementalGraphDiffService,
          useValue: { diffAndApply: diffAndApplyMock, getStoredGraph: vi.fn() },
        },
        { provide: EmbeddingService, useClass: FakeEmbeddingService },
        { provide: RAG_CFG, useValue: mockRagConfig },
        { provide: GraphStoreService, useValue: mockGraphStore },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
      ],
    }).compile();

    ragService = module.get(RagService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(() => {
    diffAndApplyMock.mockClear();
    mockGraphStore.getStoredGraph.mockClear();
    mockGraphStore.applyDiff.mockClear();
    mockTxManager.run.mockClear();
  });

  it('RagService.importGraphify delegates to IncrementalGraphDiffService.diffAndApply', async () => {
    const projectId = 'graph-diff-wiring-test';
    const nodes: GraphifyNodeDto[] = [
      { id: 'node_1', label: 'Service1', type: 'class' },
      { id: 'node_2', label: 'Service2', type: 'class' },
      { id: 'node_3', label: 'Service3', type: 'class' },
    ];
    const links: GraphifyLinkDto[] = [
      { source: 'node_1', target: 'node_2', relation: 'depends_on' },
    ];

    await ragService.importGraphify(projectId, nodes, links);

    expect(diffAndApplyMock).toHaveBeenCalledTimes(1);
    expect(diffAndApplyMock).toHaveBeenCalledWith(projectId, nodes, links);
  });

  it('passes through the full node and link arrays to diffAndApply', async () => {
    const projectId = 'graph-diff-wiring-test-2';
    const nodes: GraphifyNodeDto[] = Array.from({ length: 10 }, (_, i) => ({
      id: `node_${i}`,
      label: `Service${i}`,
      type: 'class',
    }));
    const links: GraphifyLinkDto[] = [
      { source: 'node_0', target: 'node_1', relation: 'depends_on' },
      { source: 'node_1', target: 'node_2', relation: 'uses' },
    ];

    await ragService.importGraphify(projectId, nodes, links);

    expect(diffAndApplyMock).toHaveBeenCalledTimes(1);
    expect(diffAndApplyMock).toHaveBeenCalledWith(projectId, nodes, links);
  });

  it('delegates to diffAndApply even when nodes array is empty', async () => {
    const projectId = 'graph-diff-wiring-test-3';
    const nodes: GraphifyNodeDto[] = [];
    const links: GraphifyLinkDto[] = [];

    await ragService.importGraphify(projectId, nodes, links);

    expect(diffAndApplyMock).toHaveBeenCalledTimes(1);
    expect(diffAndApplyMock).toHaveBeenCalledWith(projectId, nodes, links);
  });

  it('does not invoke deleteAllBySourceType when diffAndApply is wired', async () => {
    const projectId = 'graph-diff-wiring-test-4';
    const nodes: GraphifyNodeDto[] = [
      { id: 'node_1', label: 'Service1', type: 'class' },
    ];
    const links: GraphifyLinkDto[] = [];

    const deleteAllSpy = vi.spyOn(ragService, 'deleteAllBySourceType');

    await ragService.importGraphify(projectId, nodes, links);

    expect(deleteAllSpy).not.toHaveBeenCalled();
    deleteAllSpy.mockRestore();
  });
});
