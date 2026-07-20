// Prevent LanceDB native module from loading — it holds open handles in tests
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

import { IRagConfig } from '../config/rag.config';
import { VectorStore } from './vector-store.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

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

const mockRagConfigForSearch = makeRagConfig();

const mockEmbeddingServiceForSearch = {
  embed: jest.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  getDimensions: jest.fn().mockReturnValue(384),
  provider: 'ollama',
  model: 'nomic-embed-text',
};

describe('VectorStore lifecycle', () => {
  it('closes LanceDB connection on module destroy', () => {
    const vectorStore = new VectorStore(makeRagConfig());
    const closeSpy = jest.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).db = { close: closeSpy };

    vectorStore.onModuleDestroy();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((vectorStore as any).db).toBeNull();
  });
});

describe('VectorStore.getOrCreateTable — FTS index creation', () => {
  const mockRagConfig = makeRagConfig();

  it('calls table.createIndex with FTS config when lanceAvailable is true', async () => {
    const vectorStore = new VectorStore(mockRagConfig);
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
    (vectorStore as any).db = mockDb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;

    await vectorStore.getOrCreateTable('test-project');

    expect(createIndexSpy).toHaveBeenCalledWith(
      'content',
      expect.objectContaining({
        replace: false,
        config: expect.anything(),
      }),
    );
  });

  it('does not call table.createIndex when lanceAvailable is false', async () => {
    const vectorStore = new VectorStore(mockRagConfig);
    vectorStore.onModuleInit();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = false;

    await vectorStore.getOrCreateTable('test-project');

    // Verify no error thrown and in-memory table returned
    const table = await vectorStore.getOrCreateTable('test-project');
    expect(table).toBeDefined();
  });

  it('logs warning and does not throw when createIndex rejects', async () => {
    const vectorStore = new VectorStore(mockRagConfig);
    const loggerSpy = jest.spyOn(vectorStore['logger'], 'warn');
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
    (vectorStore as any).db = mockDb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;

    // Should not throw
    await expect(vectorStore.getOrCreateTable('test-project')).resolves.toBeDefined();
    expect(loggerSpy).toHaveBeenCalled();
    expect(loggerSpy.mock.calls[0][0]).toContain('FTS index');
  });

  it('serializes concurrent calls for the same project so the table is only created once', async () => {
    const vectorStore = new VectorStore(mockRagConfig);

    let resolveCreateTable = (_table: unknown): void => {};
    const createTablePromise = new Promise((resolve) => {
      resolveCreateTable = resolve;
    });
    const createTableSpy = jest.fn().mockReturnValue(createTablePromise);

    const mockDb = {
      tableNames: jest.fn().mockResolvedValue([]),
      createTable: createTableSpy,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).db = mockDb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;

    const first = vectorStore.getOrCreateTable('concurrent-project');
    const second = vectorStore.getOrCreateTable('concurrent-project');

    // Let both calls' preceding awaits (validateProjectId, connect, tableNames) flush
    // before asserting createTable was only invoked once.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(createTableSpy).toHaveBeenCalledTimes(1);

    resolveCreateTable({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
    });

    const [firstTable, secondTable] = await Promise.all([first, second]);
    expect(firstTable).toBe(secondTable);
    expect(createTableSpy).toHaveBeenCalledTimes(1);
  });
});

describe('VectorStore — write mutex serialization (LanceDB has no built-in concurrent-writer lock)', () => {
  const mockRagConfig = makeRagConfig();

  const mockEmbeddingService = {
    embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    providerName: 'test-provider',
    modelName: 'test-model',
    dimensions: 3,
  };

  it('serializes concurrent indexDocument writes against the same project table', async () => {
    const vectorStore = new VectorStore(mockRagConfig, mockEmbeddingService as never);

    let resolveFirstAdd: () => void = () => {};
    const firstAddPromise = new Promise<void>((resolve) => {
      resolveFirstAdd = resolve;
    });
    const addSpy = jest.fn().mockReturnValueOnce(firstAddPromise).mockResolvedValueOnce(undefined);
    const mockTable = { add: addSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const first = vectorStore.indexDocument('test-project', {
      source: 'ticket',
      sourceId: 'ticket-001',
      content: 'first',
      metadata: {},
    });
    const second = vectorStore.indexDocument('test-project', {
      source: 'ticket',
      sourceId: 'ticket-002',
      content: 'second',
      metadata: {},
    });

    // Let both calls' preceding awaits (validateProjectId, embed) flush before
    // asserting the second write hasn't started — it must wait on the first.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(addSpy).toHaveBeenCalledTimes(1);

    resolveFirstAdd();
    await Promise.all([first, second]);

    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  it('never runs indexDocument and deleteBySource writes concurrently on the same table', async () => {
    // indexDocument and deleteBySource have different numbers of awaits before
    // reaching the write lock, so which one acquires it first isn't guaranteed —
    // what the mutex guarantees is that only one write is ever in flight at a time.
    const vectorStore = new VectorStore(mockRagConfig, mockEmbeddingService as never);

    let resolveAdd: () => void = () => {};
    const addPromise = new Promise<void>((resolve) => {
      resolveAdd = resolve;
    });
    const addSpy = jest.fn().mockReturnValue(addPromise);

    let resolveDelete: () => void = () => {};
    const deletePromiseGate = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const deleteSpy = jest.fn().mockReturnValue(deletePromiseGate);

    const mockTable = { add: addSpy, delete: deleteSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const indexPromise = vectorStore.indexDocument('test-project', {
      source: 'ticket',
      sourceId: 'ticket-001',
      content: 'first',
      metadata: {},
    });
    const deletePromise = vectorStore.deleteBySource('test-project', 'ticket-001');

    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Only one of the two writes may be in flight at a time.
    expect(addSpy.mock.calls.length + deleteSpy.mock.calls.length).toBe(1);

    resolveAdd();
    resolveDelete();
    await Promise.all([indexPromise, deletePromise]);

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let one project table lock block writes to a different project table', async () => {
    const vectorStore = new VectorStore(mockRagConfig, mockEmbeddingService as never);

    let resolveAddA: () => void = () => {};
    const addAPromise = new Promise<void>((resolve) => {
      resolveAddA = resolve;
    });
    const addASpy = jest.fn().mockReturnValue(addAPromise);
    const addBSpy = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([
      ['project_project-a', { add: addASpy }],
      ['project_project-b', { add: addBSpy }],
    ]);

    const pendingA = vectorStore.indexDocument('project-a', {
      source: 'ticket',
      sourceId: 'a-1',
      content: 'a',
      metadata: {},
    });
    await vectorStore.indexDocument('project-b', {
      source: 'ticket',
      sourceId: 'b-1',
      content: 'b',
      metadata: {},
    });

    expect(addBSpy).toHaveBeenCalledTimes(1);

    resolveAddA();
    await pendingA;
  });
});

describe('VectorStore.search — native FTS path (US-003-2)', () => {
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
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const ftsRow = makeMockRecord('fts-doc-1', 'authentication error in service');
    const mockTable = makeTableWithFts([ftsRow], [ftsRow]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    await vectorStore.search('test-project', 'authentication error');

    expect(mockTable.search).toHaveBeenCalledWith('authentication error', 'fts', 'content');
  });

  it('does not call table.search() when lanceAvailable is false', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const doc = makeMockRecord('doc-1', 'auth keyword content here');
    const mockTable = makeTableWithFts([doc], [doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    await vectorStore.search('test-project', 'auth content');

    expect(mockTable.search).not.toHaveBeenCalled();
  });

  it('scores native FTS results by reciprocal position 1/(i+1)', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
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
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'result', 3);

    expect(result.results).toHaveLength(3);
    // FTS result at index 0 → score = 1/(0+1) = 1.0
    expect(result.results[0].score).toBeCloseTo(1 / (0 + 1));
    // FTS result at index 1 → score = 1/(1+1) = 0.5
    expect(result.results[1].score).toBeCloseTo(1 / (1 + 1));
    // FTS result at index 2 → score = 1/(2+1) ≈ 0.333
    expect(result.results[2].score).toBeCloseTo(1 / (2 + 1));
  });

  it('adds ftsRows to recordMap so records unique to native FTS appear in results', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
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
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'authentication failure', 5);

    const ids = result.results.map((r) => r.id);
    // fts-only-doc must appear in results because ftsRows were added to recordMap
    expect(ids).toContain('fts-only-doc');
  });
});

describe('VectorStore.search — in-memory FTS fallback path (US-003-3)', () => {
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
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const matchingDoc = makeMockRecord('matching-doc', 'authentication error occurred in service');
    const mockTable = makeTableWithRejectedSearch([matchingDoc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'authentication error', 5);

    // table.search was called (and rejected)
    expect(mockTable.search).toHaveBeenCalled();
    // but results must still be populated via simpleFtsScore fallback
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].id).toBe('matching-doc');
  });

  it('when lanceAvailable=true and table.search() rejects, logs a warning', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loggerWarnSpy = jest.spyOn((vectorStore as any).logger, 'warn');

    const doc = makeMockRecord('doc-1', 'some matching content');
    const mockTable = makeTableWithRejectedSearch([doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    await vectorStore.search('test-project', 'matching content', 5);

    const warnCalls = loggerWarnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((msg) => msg.toLowerCase().includes('fts'))).toBe(true);
  });

  it('when lanceAvailable=true and table.search() rejects, fallback scores match simpleFtsScore output', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const fullMatchDoc = makeMockRecord('full-match', 'authentication error service crash');
    const partialMatchDoc = makeMockRecord('partial-match', 'authentication only partial');
    const noMatchDoc = makeMockRecord('no-match', 'database schema migration rollback');

    const mockTable = makeTableWithRejectedSearch([fullMatchDoc, partialMatchDoc, noMatchDoc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'authentication error service', 5);

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
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
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
    (vectorStore as any).lanceAvailable = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'authentication error', 5);

    expect(mockTable.search).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].id).toBe('doc-in-memory');
  });
});

describe('VectorStore — onFirstAccess and onDestroy lifecycle hooks (US-003-5)', () => {
  const mockRagConfig = makeRagConfig();

  function makeMockDb(tableExists: boolean) {
    const mockTable = {
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
    };
    return {
      tableNames: jest.fn().mockResolvedValue(tableExists ? ['project_test-project'] : []),
      openTable: jest.fn().mockResolvedValue(mockTable),
      createTable: jest.fn().mockResolvedValue(mockTable),
      mockTable,
    };
  }

  describe('getOrCreateTable — onFirstAccess', () => {
    it('calls optimizeStrategy.onFirstAccess(projectId, table) when lanceAvailable is true', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const onFirstAccessSpy = jest.fn();
      const mockStrategy = { onFirstAccess: onFirstAccessSpy, onInsert: jest.fn(), onDestroy: jest.fn() };
      const { mockTable, ...mockDb } = makeMockDb(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).db = mockDb;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).lanceAvailable = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).optimizeStrategy = mockStrategy;

      await vectorStore.getOrCreateTable('test-project');

      expect(onFirstAccessSpy).toHaveBeenCalledWith('test-project', mockTable);
    });

    it('calls optimizeStrategy.onFirstAccess exactly once per projectId even when called multiple times', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const onFirstAccessSpy = jest.fn();
      const mockStrategy = { onFirstAccess: onFirstAccessSpy, onInsert: jest.fn(), onDestroy: jest.fn() };
      const { mockTable, ...mockDb } = makeMockDb(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).db = mockDb;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).lanceAvailable = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).optimizeStrategy = mockStrategy;

      await vectorStore.getOrCreateTable('test-project');
      await vectorStore.getOrCreateTable('test-project');
      await vectorStore.getOrCreateTable('test-project');

      expect(onFirstAccessSpy).toHaveBeenCalledTimes(1);
    });

    it('calls optimizeStrategy.onFirstAccess once per distinct projectId', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const onFirstAccessSpy = jest.fn();
      const mockStrategy = { onFirstAccess: onFirstAccessSpy, onInsert: jest.fn(), onDestroy: jest.fn() };

      const mockTableA = { delete: jest.fn().mockResolvedValue(undefined), createIndex: jest.fn().mockResolvedValue(undefined) };
      const mockTableB = { delete: jest.fn().mockResolvedValue(undefined), createIndex: jest.fn().mockResolvedValue(undefined) };
      const mockDb = {
        tableNames: jest.fn().mockResolvedValue([]),
        createTable: jest.fn()
          .mockResolvedValueOnce(mockTableA)
          .mockResolvedValueOnce(mockTableB),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).db = mockDb;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).lanceAvailable = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).optimizeStrategy = mockStrategy;

      await vectorStore.getOrCreateTable('project-a');
      await vectorStore.getOrCreateTable('project-b');
      // Second call for project-a — must NOT trigger another onFirstAccess
      await vectorStore.getOrCreateTable('project-a');

      expect(onFirstAccessSpy).toHaveBeenCalledTimes(2);
      expect(onFirstAccessSpy).toHaveBeenCalledWith('project-a', mockTableA);
      expect(onFirstAccessSpy).toHaveBeenCalledWith('project-b', mockTableB);
    });

    it('does not call optimizeStrategy.onFirstAccess when lanceAvailable is false', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const onFirstAccessSpy = jest.fn();
      const mockStrategy = { onFirstAccess: onFirstAccessSpy, onInsert: jest.fn(), onDestroy: jest.fn() };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).lanceAvailable = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).optimizeStrategy = mockStrategy;

      await vectorStore.getOrCreateTable('test-project');

      expect(onFirstAccessSpy).not.toHaveBeenCalled();
    });

    it('does not call optimizeStrategy.onFirstAccess when optimizeStrategy is not injected', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const { mockTable, ...mockDb } = makeMockDb(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).db = mockDb;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).lanceAvailable = true;
      // optimizeStrategy is undefined (not injected)

      await expect(vectorStore.getOrCreateTable('test-project')).resolves.toBeDefined();
    });
  });

  describe('onModuleDestroy — onDestroy', () => {
    it('calls optimizeStrategy.onDestroy() during onModuleDestroy', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const onDestroySpy = jest.fn().mockResolvedValue(undefined);
      const mockStrategy = { onFirstAccess: jest.fn(), onInsert: jest.fn(), onDestroy: onDestroySpy };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).optimizeStrategy = mockStrategy;

      await vectorStore.onModuleDestroy();

      expect(onDestroySpy).toHaveBeenCalledTimes(1);
    });

    it('calls optimizeStrategy.onDestroy() even when no LanceDB connection exists', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      const onDestroySpy = jest.fn().mockResolvedValue(undefined);
      const mockStrategy = { onFirstAccess: jest.fn(), onInsert: jest.fn(), onDestroy: onDestroySpy };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).db = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vectorStore as any).optimizeStrategy = mockStrategy;

      await vectorStore.onModuleDestroy();

      expect(onDestroySpy).toHaveBeenCalledTimes(1);
    });

    it('does not throw when optimizeStrategy is not injected', async () => {
      const vectorStore = new VectorStore(mockRagConfig);
      // optimizeStrategy is undefined (not injected)

      await expect(vectorStore.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});

describe('VectorStore.indexDocument — onInsert Strategy Hook (US-003-4)', () => {
  const mockRagConfig = makeRagConfig();

  const mockEmbeddingService = {
    embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    providerName: 'test-provider',
    modelName: 'test-model',
    dimensions: 3,
  };

  it('calls optimizeStrategy.onInsert(projectId, table) after table.add() when lanceAvailable is true', async () => {
    const vectorStore = new VectorStore(mockRagConfig, mockEmbeddingService as never);
    const onInsertSpy = jest.fn().mockResolvedValue(undefined);
    const mockStrategy = { onInsert: onInsertSpy } as unknown as never;
    const mockTable = { add: jest.fn().mockResolvedValue(undefined) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).optimizeStrategy = mockStrategy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    await vectorStore.indexDocument('test-project', {
      source: 'ticket',
      sourceId: 'ticket-001',
      content: 'Test document content',
      metadata: { ref: 'TEST-1' },
    });

    expect(onInsertSpy).toHaveBeenCalledWith('test-project', mockTable);
  });

  it('does not call optimizeStrategy.onInsert() when lanceAvailable is false', async () => {
    const vectorStore = new VectorStore(mockRagConfig, mockEmbeddingService as never);
    const onInsertSpy = jest.fn().mockResolvedValue(undefined);
    const mockStrategy = { onInsert: onInsertSpy } as unknown as never;
    const mockTable = { add: jest.fn().mockResolvedValue(undefined) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).optimizeStrategy = mockStrategy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    await vectorStore.indexDocument('test-project', {
      source: 'ticket',
      sourceId: 'ticket-001',
      content: 'Test document content',
      metadata: { ref: 'TEST-1' },
    });

    expect(onInsertSpy).not.toHaveBeenCalled();
  });
});

describe('VectorStore.optimizeTable (US-004)', () => {
  it('calls table.optimize() when lanceAvailable is true', async () => {
    const vectorStore = new VectorStore(makeRagConfig());
    const mockTable = { optimize: jest.fn().mockResolvedValue(undefined) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(vectorStore as any, 'getOrCreateTable').mockResolvedValue(mockTable);

    await vectorStore.optimizeTable('test-project');

    expect(mockTable.optimize).toHaveBeenCalledTimes(1);
  });

  it('does not call table.optimize() when lanceAvailable is false', async () => {
    const vectorStore = new VectorStore(makeRagConfig());
    const mockTable = { optimize: jest.fn().mockResolvedValue(undefined) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(vectorStore as any, 'getOrCreateTable').mockResolvedValue(mockTable);

    await vectorStore.optimizeTable('test-project');

    expect(mockTable.optimize).not.toHaveBeenCalled();
  });
});

describe('VectorStore.deleteAllBySourceType (US-002)', () => {
  it('AC1: deletes all records where source = sourceType and returns count', async () => {
    const vectorStore = new VectorStore(makeRagConfig());
    const mockTable = {
      countRows: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(vectorStore as any, 'getOrCreateTable').mockResolvedValue(mockTable);

    const result = await vectorStore.deleteAllBySourceType('proj-1', 'code');

    expect(result).toBe(3);
    expect(mockTable.delete).toHaveBeenCalledWith("source = 'code'");
  });

  it('AC2: returns 0 when no records exist for the source type', async () => {
    const vectorStore = new VectorStore(makeRagConfig());
    const mockTable = {
      countRows: jest.fn().mockResolvedValue(0),
      query: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(vectorStore as any, 'getOrCreateTable').mockResolvedValue(mockTable);

    const result = await vectorStore.deleteAllBySourceType('proj-1', 'code');

    expect(result).toBe(0);
  });

  it('supports source-based deletes for the in-memory fallback table', async () => {
    const mockEmbeddingService = {
      embed: jest.fn().mockResolvedValue(new Float32Array(384).fill(0)),
      providerName: 'ollama',
      modelName: 'nomic-embed-text',
      dimensions: 384,
    };

    const vectorStore = new VectorStore(makeRagConfig({ inMemoryOnly: true }), mockEmbeddingService as never);

    await vectorStore.indexDocument('proj-1', {
      source: 'code',
      sourceId: 'node-1',
      content: 'class ExampleNode',
      metadata: {},
    });
    await vectorStore.indexDocument('proj-1', {
      source: 'manual',
      sourceId: 'doc-1',
      content: 'manual ExampleDoc',
      metadata: {},
    });

    const deleted = await vectorStore.deleteAllBySourceType('proj-1', 'code');
    const remaining = await vectorStore.listDocuments('proj-1', 10);

    expect(deleted).toBe(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe('manual');
  });
});

describe('VectorStore.search — Provenance Envelope (AC-1 through AC-6)', () => {
  function makeTableWithProvenance(allRows: AnyRecord[]) {
    return {
      countRows: jest.fn().mockResolvedValue(allRows.length || 1),
      query: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(allRows),
      }),
      search: jest.fn().mockResolvedValue(allRows),
      vectorSearch: jest.fn().mockReturnValue({
        distanceType: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(allRows),
      }),
    };
  }

  it('AC-1: SearchKbResponseDto.provenance is non-null on success', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const doc = makeMockRecord('doc-1', 'authentication error content');
    const mockTable = makeTableWithProvenance([doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'authentication error', 5);

    expect(result.provenance).toBeDefined();
    expect(result.provenance).not.toBeNull();
  });

  it('AC-2: SearchKbResponseDto.provenance.sources lists unique source_type + source_id pairs only once', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    // Multiple results with the same (source, source_id) pair
    const createdAt = new Date().toISOString();
    const doc1: AnyRecord = {
      id: 'doc-1',
      source: 'ticket',
      source_id: 'ticket-123',
      content: 'error in auth service',
      vector: [],
      metadata: '{}',
      created_at: createdAt,
      provider: 'ollama',
      model: 'nomic-embed-text',
    };
    const doc2: AnyRecord = {
      id: 'doc-2',
      source: 'ticket',
      source_id: 'ticket-123',
      content: 'another error in auth service',
      vector: [],
      metadata: '{}',
      created_at: createdAt,
      provider: 'ollama',
      model: 'nomic-embed-text',
    };

    const mockTable = makeTableWithProvenance([doc1, doc2]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'error auth', 5);

    // Should have exactly one source entry despite multiple results from same source
    const sourceEntry = result.provenance?.sources?.find(
      (s) => s.sourceType === 'ticket' && s.sourceId === 'ticket-123',
    );
    expect(sourceEntry).toBeDefined();

    // Count how many times this source appears in provenance.sources
    const count = result.provenance?.sources?.filter(
      (s) => s.sourceType === 'ticket' && s.sourceId === 'ticket-123',
    ).length;
    expect(count).toBe(1);
  });

  it('AC-3: KbResultDto.provenance.indexedAt is a valid ISO timestamp', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const now = new Date().toISOString();
    const doc = makeMockRecord('doc-1', 'test content');
    doc.created_at = now;

    const mockTable = makeTableWithProvenance([doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'test content', 5);

    expect(result.results).toHaveLength(1);
    const indexedAt = result.results[0].provenance?.indexedAt;
    expect(indexedAt).toBeDefined();
    // Check if it's a valid ISO string
    expect(new Date(indexedAt as string).toISOString()).toBe(now);
  });

  it('AC-4: KbResultDto.provenance.sourceProjectId equals the request projectId', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const doc = makeMockRecord('doc-1', 'test content');
    const mockTable = makeTableWithProvenance([doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const result = await vectorStore.search('test-project', 'test content', 5);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].provenance?.sourceProjectId).toBe('test-project');
  });

  it('AC-5: No cross-project leakage — all results have sourceProjectId matching request', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    // Even if somehow a document from another project slipped in
    const doc1 = makeMockRecord('doc-1', 'content from project-a');
    const doc2 = makeMockRecord('doc-2', 'content from project-a');

    const mockTable = makeTableWithProvenance([doc1, doc2]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_project-a', mockTable]]);

    const result = await vectorStore.search('project-a', 'content', 5);

    // All results must have sourceProjectId === 'project-a'
    result.results.forEach((r) => {
      expect(r.provenance?.sourceProjectId).toBe('project-a');
    });
  });

  it('AC-6: SearchKbResponseDto.provenance.retrievedAt is within 1 second of server response', async () => {
    const vectorStore = new VectorStore(
      mockRagConfigForSearch,
      mockEmbeddingServiceForSearch as never,
    );

    const doc = makeMockRecord('doc-1', 'test content');
    const mockTable = makeTableWithProvenance([doc]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).lanceAvailable = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vectorStore as any).tableCache = new Map([['project_test-project', mockTable]]);

    const beforeSearch = Date.now();
    const result = await vectorStore.search('test-project', 'test content', 5);
    const afterSearch = Date.now();

    const retrievedAt = result.provenance?.retrievedAt;
    expect(retrievedAt).toBeDefined();

    const retrievedAtMs = new Date(retrievedAt as string).getTime();
    const timeDiff = Math.abs(retrievedAtMs - beforeSearch);

    // Should be within 1 second (1000ms) of the search start
    expect(timeDiff).toBeLessThan(1000);
  });
});
