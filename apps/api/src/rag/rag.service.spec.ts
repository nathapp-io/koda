import {
  RagService,
  reciprocalRankFusion,
  simpleFtsScore,
  getSimilarityTier,
  getVerdict,
} from './rag.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function makeMockRecord(id: string, content: string): AnyRecord {
  return {
    id,
    source: 'ticket',
    source_id: id,
    content,
    vector: [],
    metadata: '{}',
    created_at: new Date().toISOString(),
    provider: 'ollama',
    model: 'nomic-embed-text',
  };
}

const mockConfigServiceForSearch = {
  get: (key: string): unknown => {
    const config: Record<string, unknown> = {
      'rag.lancedbPath': './lancedb',
      'rag.similarityHigh': 0.85,
      'rag.similarityMedium': 0.70,
      'rag.similarityLow': 0.50,
      'rag.ftsIndexMode': 'simple',
    };
    return config[key];
  },
};

const mockEmbeddingServiceForSearch = {
  embed: jest.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  getDimensions: jest.fn().mockReturnValue(384),
  provider: 'ollama',
  model: 'nomic-embed-text',
};

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

describe('RagService lifecycle', () => {
  it('closes LanceDB connection on module destroy', () => {
    const configService = {
      get: (key: string): unknown => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': './lancedb',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
          'rag.ftsIndexMode': 'simple',
        };
        return config[key];
      },
    };

    const ragService = new RagService(configService as never);
    const closeSpy = jest.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).db = { close: closeSpy };

    ragService.onModuleDestroy();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ragService as any).db).toBeNull();
  });
});

describe('RagService.getOrCreateTable — FTS index creation', () => {
  const mockConfigService = {
    get: (key: string): unknown => {
      const config: Record<string, unknown> = {
        'rag.lancedbPath': './lancedb',
        'rag.similarityHigh': 0.85,
        'rag.similarityMedium': 0.70,
        'rag.similarityLow': 0.50,
        'rag.ftsIndexMode': 'simple',
      };
      return config[key];
    },
  };

  it('calls table.createIndex with FTS config when lanceAvailable is true', async () => {
    const ragService = new RagService(mockConfigService as never);
    const createIndexSpy = jest.fn().mockResolvedValue(undefined);
    const deleteSpy = jest.fn().mockResolvedValue(undefined);

    const mockDb = {
      tableNames: jest.fn().mockResolvedValue([]),
      createTable: jest.fn().mockResolvedValue({
        delete: deleteSpy,
        createIndex: createIndexSpy,
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).db = mockDb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;

    await ragService.getOrCreateTable('test-project');

    expect(createIndexSpy).toHaveBeenCalledWith(
      'content',
      expect.objectContaining({
        replace: false,
        config: expect.anything(),
      }),
    );
  });

  it('does not call table.createIndex when lanceAvailable is false', async () => {
    const ragService = new RagService(mockConfigService as never);
    ragService.onModuleInit();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = false;

    await ragService.getOrCreateTable('test-project');

    // Verify no error thrown and in-memory table returned
    const table = await ragService.getOrCreateTable('test-project');
    expect(table).toBeDefined();
  });

  it('logs warning and does not throw when createIndex rejects', async () => {
    const ragService = new RagService(mockConfigService as never);
    const loggerSpy = jest.spyOn(ragService['logger'], 'warn');
    const createIndexError = new Error('Index already exists');
    const createIndexSpy = jest.fn().mockRejectedValue(createIndexError);
    const deleteSpy = jest.fn().mockResolvedValue(undefined);

    const mockDb = {
      tableNames: jest.fn().mockResolvedValue([]),
      createTable: jest.fn().mockResolvedValue({
        delete: deleteSpy,
        createIndex: createIndexSpy,
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).db = mockDb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;

    // Should not throw
    await expect(ragService.getOrCreateTable('test-project')).resolves.toBeDefined();
    expect(loggerSpy).toHaveBeenCalled();
    expect(loggerSpy.mock.calls[0][0]).toContain('FTS index');
  });
});

describe('reciprocalRankFusion — export (US-003-2 AC-3)', () => {
  it('is exported from rag.service.ts', () => {
    expect(reciprocalRankFusion).toBeDefined();
    expect(typeof reciprocalRankFusion).toBe('function');
  });
});

describe('RagService.search — native FTS path (US-003-2)', () => {
  function makeTableWithFts(
    allRows: AnyRecord[],
    ftsRows: AnyRecord[],
    vectorRows: AnyRecord[] = [],
  ) {
    return {
      countRows: jest.fn().mockResolvedValue(allRows.length || 1),
      query: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(allRows),
      }),
      search: jest.fn().mockResolvedValue(ftsRows),
      vectorSearch: jest.fn().mockReturnValue({
        distanceType: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(vectorRows),
      }),
    };
  }

  it('calls table.search(query, "fts", "content") when lanceAvailable is true', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    const ftsRow = makeMockRecord('fts-doc-1', 'authentication error in service');
    const mockTable = makeTableWithFts([ftsRow], [ftsRow]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    await ragService.search('test-project', 'authentication error');

    expect(mockTable.search).toHaveBeenCalledWith('authentication error', 'fts', 'content');
  });

  it('does not call table.search() when lanceAvailable is false', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    const doc = makeMockRecord('doc-1', 'auth keyword content here');
    const mockTable = makeTableWithFts([doc], [doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    await ragService.search('test-project', 'auth content');

    expect(mockTable.search).not.toHaveBeenCalled();
  });

  it('scores native FTS results by reciprocal position 1/(i+1)', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    const ftsRows = [
      makeMockRecord('fts-1', 'first result document'),
      makeMockRecord('fts-2', 'second result document'),
      makeMockRecord('fts-3', 'third result document'),
    ];

    // No vector results — FTS scores drive final output
    const mockTable = makeTableWithFts(ftsRows, ftsRows, []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await ragService.search('test-project', 'result', 3);

    expect(result.results).toHaveLength(3);
    // FTS result at index 0 → score = 1/(0+1) = 1.0
    expect(result.results[0].score).toBeCloseTo(1 / (0 + 1));
    // FTS result at index 1 → score = 1/(1+1) = 0.5
    expect(result.results[1].score).toBeCloseTo(1 / (1 + 1));
    // FTS result at index 2 → score = 1/(2+1) ≈ 0.333
    expect(result.results[2].score).toBeCloseTo(1 / (2 + 1));
  });

  it('adds ftsRows to recordMap so records unique to native FTS appear in results', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    // fts-only-doc is returned by native FTS but not in the allRows table scan
    const scannedDoc = makeMockRecord('scanned-doc', 'some generic content');
    const ftsOnlyDoc = makeMockRecord('fts-only-doc', 'authentication failure critical');

    const mockTable = makeTableWithFts(
      [scannedDoc],          // allRows: only scanned-doc
      [ftsOnlyDoc, scannedDoc], // ftsRows: fts-only-doc is the top FTS hit
      [],                    // vectorRows: empty
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await ragService.search('test-project', 'authentication failure', 5);

    const ids = result.results.map((r) => r.id);
    // fts-only-doc must appear in results because ftsRows were added to recordMap
    expect(ids).toContain('fts-only-doc');
  });
});

describe('RagService.search — in-memory FTS fallback path (US-003-3)', () => {
  function makeTableWithRejectedSearch(allRows: AnyRecord[]) {
    return {
      countRows: jest.fn().mockResolvedValue(allRows.length || 1),
      query: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(allRows),
      }),
      search: jest.fn().mockRejectedValue(new Error('tantivy index not ready')),
      vectorSearch: jest.fn().mockReturnValue({
        distanceType: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
    };
  }

  it('when lanceAvailable=true and table.search() rejects, falls back to simpleFtsScore and returns non-empty results', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    const matchingDoc = makeMockRecord('matching-doc', 'authentication error occurred in service');
    const mockTable = makeTableWithRejectedSearch([matchingDoc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await ragService.search('test-project', 'authentication error', 5);

    // table.search was called (and rejected)
    expect(mockTable.search).toHaveBeenCalled();
    // but results must still be populated via simpleFtsScore fallback
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].id).toBe('matching-doc');
  });

  it('when lanceAvailable=true and table.search() rejects, logs a warning', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loggerWarnSpy = jest.spyOn((ragService as any).logger, 'warn');

    const doc = makeMockRecord('doc-1', 'some matching content');
    const mockTable = makeTableWithRejectedSearch([doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    await ragService.search('test-project', 'matching content', 5);

    const warnCalls = loggerWarnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((msg) => msg.toLowerCase().includes('fts'))).toBe(true);
  });

  it('when lanceAvailable=true and table.search() rejects, fallback scores match simpleFtsScore output', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    const fullMatchDoc = makeMockRecord('full-match', 'authentication error service crash');
    const partialMatchDoc = makeMockRecord('partial-match', 'authentication only partial');
    const noMatchDoc = makeMockRecord('no-match', 'database schema migration rollback');

    const mockTable = makeTableWithRejectedSearch([fullMatchDoc, partialMatchDoc, noMatchDoc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await ragService.search('test-project', 'authentication error service', 5);

    // no-match doc should not appear — simpleFtsScore returns 0 for it
    const ids = result.results.map((r) => r.id);
    expect(ids).not.toContain('no-match');
    // full-match should score higher than partial-match
    const fullIdx = ids.indexOf('full-match');
    const partialIdx = ids.indexOf('partial-match');
    expect(fullIdx).toBeGreaterThanOrEqual(0);
    expect(partialIdx).toBeGreaterThanOrEqual(0);
    expect(fullIdx).toBeLessThan(partialIdx);
  });

  it('when lanceAvailable=false, uses simpleFtsScore without calling table.search()', async () => {
    const ragService = new RagService(
      mockConfigServiceForSearch as never,
      mockEmbeddingServiceForSearch as never,
    );

    const doc = makeMockRecord('doc-in-memory', 'authentication error keyword content');
    const mockTable = {
      countRows: jest.fn().mockResolvedValue(1),
      query: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([doc]),
      }),
      search: jest.fn().mockResolvedValue([]),
      vectorSearch: jest.fn().mockReturnValue({
        distanceType: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).lanceAvailable = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await ragService.search('test-project', 'authentication error', 5);

    expect(mockTable.search).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].id).toBe('doc-in-memory');
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
