import { IRagConfig } from '../config/rag.config';
import {
  RagService,
  reciprocalRankFusion,
  simpleFtsScore,
  getSimilarityTier,
  getVerdict,
} from './rag.service';
import { VectorStore } from './vector-store.service';

function makeRagConfig(overrides: Partial<IRagConfig> = {}): IRagConfig {
  return {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath: './lancedb',
    inMemoryOnly: false,
    ftsIndexMode: 'simple',
    similarityHigh: 0.85,
    similarityMedium: 0.70,
    similarityLow: 0.50,
    ftsOptimizeStrategy: 'counter',
    ftsOptimizeThreshold: 10,
    ftsOptimizeIntervalMs: 300000,
    graphifyEnabledCacheTtlSec: 60,
    ...overrides,
  };
}

describe('simpleFtsScore', () => {
  it('returns 0 for empty query', () => {
    expect(simpleFtsScore('some content here', '')).toBe(0);
  });

  it('returns 0 when query has no terms longer than 2 chars', () => {
    expect(simpleFtsScore('some content here', 'a b')).toBe(0);
  });

  it('returns 1 for single term full match', () => {
    expect(simpleFtsScore('authentication service error', 'auth')).toBe(1);
  });

  it('returns 1 when all query terms are in content', () => {
    const score = simpleFtsScore('null reference error in auth service', 'null auth error');
    expect(score).toBeCloseTo(1);
  });

  it('returns partial score when only some terms match', () => {
    const score = simpleFtsScore('null reference in database', 'null auth error');
    // 1 out of 3 terms match ('null')
    expect(score).toBeCloseTo(1 / 3);
  });

  it('returns 0 when no terms match', () => {
    expect(simpleFtsScore('database schema migration', 'frontend react component')).toBe(0);
  });

  it('is case-insensitive', () => {
    const score = simpleFtsScore('Auth Service Error', 'auth service');
    expect(score).toBeCloseTo(1);
  });
});

describe('reciprocalRankFusion', () => {
  it('sums RRF scores for document appearing in both lists', () => {
    const vectorRanks = [{ id: 'doc1' }, { id: 'doc2' }];
    const ftsRanks = [{ id: 'doc2' }, { id: 'doc3' }];
    const k = 60;

    const result = reciprocalRankFusion(vectorRanks, ftsRanks, k);
    const doc1 = result.find((r) => r.id === 'doc1');
    const doc2 = result.find((r) => r.id === 'doc2');
    const doc3 = result.find((r) => r.id === 'doc3');

    // doc2 appears in both lists so should have the highest combined score
    expect(doc2).toBeDefined();
    expect(doc1).toBeDefined();
    expect(doc3).toBeDefined();
    if (doc2 && doc1 && doc3) {
      expect(doc2.rrfScore).toBeGreaterThan(doc1.rrfScore);
      expect(doc2.rrfScore).toBeGreaterThan(doc3.rrfScore);
    }
  });

  it('uses k=60 by default', () => {
    const vectorRanks = [{ id: 'a' }];
    const result = reciprocalRankFusion(vectorRanks, []);
    expect(result[0].rrfScore).toBeCloseTo(1 / (60 + 0 + 1));
  });

  it('returns empty array when both lists are empty', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it('sorts results by descending RRF score', () => {
    const vectorRanks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const ftsRanks = [{ id: 'b' }, { id: 'a' }];
    const result = reciprocalRankFusion(vectorRanks, ftsRanks);

    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].rrfScore).toBeGreaterThanOrEqual(result[i + 1].rrfScore);
    }
  });

  it('handles document in only one list', () => {
    const result = reciprocalRankFusion([{ id: 'solo' }], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('solo');
  });
});

describe('getSimilarityTier', () => {
  const high = 0.85;
  const medium = 0.70;
  const low = 0.50;

  it('returns "high" when score >= high threshold', () => {
    expect(getSimilarityTier(0.90, high, medium, low)).toBe('high');
    expect(getSimilarityTier(0.85, high, medium, low)).toBe('high');
  });

  it('returns "medium" when score >= medium but < high', () => {
    expect(getSimilarityTier(0.75, high, medium, low)).toBe('medium');
    expect(getSimilarityTier(0.70, high, medium, low)).toBe('medium');
  });

  it('returns "low" when score >= low but < medium', () => {
    expect(getSimilarityTier(0.60, high, medium, low)).toBe('low');
    expect(getSimilarityTier(0.50, high, medium, low)).toBe('low');
  });

  it('returns "none" when score < low threshold', () => {
    expect(getSimilarityTier(0.49, high, medium, low)).toBe('none');
    expect(getSimilarityTier(0, high, medium, low)).toBe('none');
  });
});

describe('getVerdict', () => {
  const high = 0.85;
  const medium = 0.70;

  it('returns "likely_duplicate" when top score >= high', () => {
    expect(getVerdict(0.90, high, medium)).toBe('likely_duplicate');
    expect(getVerdict(0.85, high, medium)).toBe('likely_duplicate');
  });

  it('returns "possibly_related" when top score >= medium but < high', () => {
    expect(getVerdict(0.75, high, medium)).toBe('possibly_related');
    expect(getVerdict(0.70, high, medium)).toBe('possibly_related');
  });

  it('returns "no_match" when top score < medium', () => {
    expect(getVerdict(0.69, high, medium)).toBe('no_match');
    expect(getVerdict(0, high, medium)).toBe('no_match');
  });
});

describe('reciprocalRankFusion — export (US-003-2 AC-3)', () => {
  it('is exported from rag.service.ts', () => {
    expect(reciprocalRankFusion).toBeDefined();
    expect(typeof reciprocalRankFusion).toBe('function');
  });
});

describe('simpleFtsScore — export (US-003-3 AC-3)', () => {
  it('is exported from rag.service.ts', () => {
    expect(simpleFtsScore).toBeDefined();
    expect(typeof simpleFtsScore).toBe('function');
  });

  it('returns a score > 0 for matching content', () => {
    expect(simpleFtsScore('authentication error service', 'authentication')).toBeGreaterThan(0);
  });
});

describe('RagService.importGraphify (US-002)', () => {
  const mockRagConfig = makeRagConfig();

  const mockEmbeddingService = {
    embed: jest.fn().mockResolvedValue(new Float32Array(384).fill(0)),
    providerName: 'ollama',
    modelName: 'nomic-embed-text',
    dimensions: 384,
  };

  function makeRagService(): RagService {
    const vectorStore = new VectorStore(mockRagConfig, mockEmbeddingService as never);
    return new RagService(vectorStore);
  }

  it('AC3: calls deleteAllBySourceType before indexing any nodes', async () => {
    const ragService = makeRagService();
    const callOrder: string[] = [];
    const deleteAllBySourceTypeSpy = jest.spyOn(ragService, 'deleteAllBySourceType').mockImplementation(async () => {
      callOrder.push('deleteAllBySourceType');
      return 1;
    });
    const indexDocumentSpy = jest.spyOn(ragService, 'indexDocument').mockImplementation(async () => {
      callOrder.push('indexDocument');
    });

    const nodes = [
      { id: 'node-1', label: 'MyClass', type: 'class', source_file: 'app.ts' },
    ];
    const links: unknown[] = [];

    await ragService.importGraphify('proj-1', nodes, links);

    expect(deleteAllBySourceTypeSpy).toHaveBeenCalledWith('proj-1', 'code');
    expect(callOrder[0]).toBe('deleteAllBySourceType');
    expect(callOrder.indexOf('deleteAllBySourceType')).toBeLessThan(callOrder.indexOf('indexDocument'));
  });

  it('AC4: with empty links, indexes each node with content "{type} {label} in {source_file}" (omitting source_file segment when absent)', async () => {
    const ragService = makeRagService();
    jest.spyOn(ragService, 'deleteAllBySourceType').mockResolvedValue(0);
    const indexDocumentSpy = jest.spyOn(ragService, 'indexDocument').mockResolvedValue(undefined);

    const nodes = [
      { id: 'node-1', label: 'MyClass', type: 'class', source_file: 'app.ts' },
      { id: 'node-2', label: 'MyInterface', type: 'interface' },
    ];

    await ragService.importGraphify('proj-1', nodes, []);

    expect(indexDocumentSpy).toHaveBeenCalledTimes(2);

    // First node with source_file
    expect(indexDocumentSpy).toHaveBeenNthCalledWith(1, 'proj-1', {
      source: 'code',
      sourceId: 'node-1',
      content: 'class MyClass in app.ts',
      metadata: expect.any(Object),
    });

    // Second node without source_file
    expect(indexDocumentSpy).toHaveBeenNthCalledWith(2, 'proj-1', {
      source: 'code',
      sourceId: 'node-2',
      content: 'interface MyInterface',
      metadata: expect.any(Object),
    });
  });

  it('AC5: builds content that includes "{relation} {neighbor_label}" for each link where node is the source', async () => {
    const ragService = makeRagService();
    jest.spyOn(ragService, 'deleteAllBySourceType').mockResolvedValue(0);
    const indexDocumentSpy = jest.spyOn(ragService, 'indexDocument').mockResolvedValue(undefined);

    const nodes = [
      { id: 'node-1', label: 'MyClass', type: 'class', source_file: 'app.ts' },
      { id: 'node-2', label: 'MyInterface', type: 'interface', source_file: 'types.ts' },
    ];
    const links = [
      { source: 'node-1', target: 'node-2', relation: 'implements' },
    ];

    await ragService.importGraphify('proj-1', nodes, links);

    expect(indexDocumentSpy).toHaveBeenNthCalledWith(1, 'proj-1', {
      source: 'code',
      sourceId: 'node-1',
      content: 'class MyClass in app.ts: implements MyInterface',
      metadata: expect.any(Object),
    });
  });

  it('AC6: calls indexDocument with source: "code", sourceId: node.id, and metadata containing label, type, source_file, and community', async () => {
    const ragService = makeRagService();
    jest.spyOn(ragService, 'deleteAllBySourceType').mockResolvedValue(0);
    const indexDocumentSpy = jest.spyOn(ragService, 'indexDocument').mockResolvedValue(undefined);

    const nodes = [
      { id: 'node-1', label: 'MyClass', type: 'class', source_file: 'app.ts', community: 0 },
    ];

    await ragService.importGraphify('proj-1', nodes, []);

    expect(indexDocumentSpy).toHaveBeenCalledWith('proj-1', {
      source: 'code',
      sourceId: 'node-1',
      content: expect.any(String),
      metadata: {
        label: 'MyClass',
        type: 'class',
        source_file: 'app.ts',
        community: 0,
      },
    });
  });

  it('AC7: returns { imported: 0, cleared: N } for empty nodes array', async () => {
    const ragService = makeRagService();
    jest.spyOn(ragService, 'deleteAllBySourceType').mockResolvedValue(5);

    const result = await ragService.importGraphify('proj-1', [], []);

    expect(result).toEqual({ imported: 0, cleared: 5 });
  });

  it('defaults type to "node" when absent', async () => {
    const ragService = makeRagService();
    jest.spyOn(ragService, 'deleteAllBySourceType').mockResolvedValue(0);
    const indexDocumentSpy = jest.spyOn(ragService, 'indexDocument').mockResolvedValue(undefined);

    const nodes = [
      { id: 'node-1', label: 'MyEntity', source_file: 'file.ts' },
    ];

    await ragService.importGraphify('proj-1', nodes, []);

    expect(indexDocumentSpy).toHaveBeenCalledWith('proj-1', {
      source: 'code',
      sourceId: 'node-1',
      content: 'node MyEntity in file.ts',
      metadata: expect.any(Object),
    });
  });

  it('returns { imported: N, cleared: M } after successful import', async () => {
    const ragService = makeRagService();
    jest.spyOn(ragService, 'deleteAllBySourceType').mockResolvedValue(3);
    jest.spyOn(ragService, 'indexDocument').mockResolvedValue(undefined);

    const nodes = [
      { id: 'node-1', label: 'MyClass', type: 'class', source_file: 'app.ts' },
      { id: 'node-2', label: 'MyInterface', type: 'interface', source_file: 'types.ts' },
    ];

    const result = await ragService.importGraphify('proj-1', nodes, []);

    expect(result).toEqual({ imported: 2, cleared: 3 });
  });
});
