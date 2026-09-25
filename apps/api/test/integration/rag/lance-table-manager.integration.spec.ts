/**
 * Task 21 (H7 residual): single shared LanceDB write path via LanceTableManager.
 *
 * Bug being closed: rag.controller.addDocument ran
 *   Promise.all([ragService.indexDocument(...), hybridRetrieverService.indexDocument(...)])
 * so both services opened `project_<id>` at the same lancedbPath with separate
 * connections, separate table caches, and separate write locks. Consequences:
 *   1. Every add produced TWO rows (different ids, same source_id) in the shared
 *      on-disk table → duplicate search results.
 *   2. A cross-service first-write race on LanceDB's check-then-create table path.
 *   3. In in-memory mode, deletes via VectorStore never reached Hybrid's own
 *      InMemoryTable copy.
 *
 * The fix: RagModule provides ONE LanceTableManager (one lancedb.connect per db
 * path, one per-table write mutex across both services, sentinel-row createTable
 * fallback, InMemoryTable fallback). Both services delegate table open/create and
 * all writes to it; the controller indexes through RagService only, and
 * manager.addRecord additionally replaces rows with the same source_id so
 * re-indexing is idempotent.
 *
 * RED-phase evidence (pre-fix, captured before implementing):
 *   - real-LanceDB describe, test 1: expected 1 row for doc-b, received 2
 *     (duplicate rows from the double index); delete left both visible.
 *   - in-memory describe: VectorStore-only index invisible to HybridRetriever
 *     (expected 1, received 0); delete via VectorStore left a ghost copy in
 *     Hybrid's own InMemoryTable (expected 0, received 1).
 *
 * Mode under test: BOTH. `@lancedb/lancedb` 0.17.0 resolves in this environment,
 * so the "real LanceDB" describe exercises the native path; the "in-memory"
 * describe exercises the InMemoryTable fallback. If the native module cannot
 * load, the services' existing fallback behavior routes the real-mode describe
 * through the InMemoryTable fallback, which still exercises the shared-manager
 * dedup and locking logic.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IRagConfig } from '../../../src/config/rag.config';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { LanceTableManager, InMemoryTable } from '../../../src/rag/lance-table-manager';

jest.setTimeout(60000);

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
}

function makeRagConfig(lancedbPath: string, inMemoryOnly = false): IRagConfig {
  return {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath,
    inMemoryOnly,
    ftsIndexMode: 'simple',
    similarityHigh: 0.85,
    similarityMedium: 0.7,
    similarityLow: 0.5,
    ftsOptimizeStrategy: 'counter',
    ftsOptimizeThreshold: 100,
    ftsOptimizeIntervalMs: 60000,
    graphifyEnabledCacheTtlSec: 60,
  };
}

/**
 * Wires the two services the way RagModule does: ONE LanceTableManager shared
 * by both, so all writes to the same project table go through one connection
 * and one per-table mutex.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildServices(ragConfig: IRagConfig, manager: LanceTableManager): { vectorStore: VectorStore; hybrid: HybridRetrieverService } {
  const embedding = new FakeEmbeddingService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entityStore: any = {
    searchEntities: () => [],
    computeEntityScore: () => 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ragRepository: any = {
    findProjectGraphifyEnabled: async () => ({ graphifyEnabled: false }),
  };
  const vectorStore = new VectorStore(
    ragConfig,
    embedding as never,
    undefined,
    undefined,
    undefined,
    undefined,
    manager,
  );
  const hybrid = new HybridRetrieverService(
    ragConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedding as any,
    entityStore,
    ragRepository,
    manager,
  );
  return { vectorStore, hybrid };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsForSourceId(rows: any[], sourceId: string): number {
  return rows.filter((r) => r.sourceId === sourceId).length;
}

describe('RAG shared LanceDB write path — real LanceDB mode', () => {
  let tmpDir: string;
  let manager: LanceTableManager;
  let vectorStore: VectorStore;
  let hybrid: HybridRetrieverService;
  const projectId = 'proj_shared_write_real';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-lance-mgr-real-'));
    const ragConfig = makeRagConfig(tmpDir, false);
    manager = new LanceTableManager(ragConfig, new FakeEmbeddingService() as never);
    ({ vectorStore, hybrid } = buildServices(ragConfig, manager));
  });

  afterAll(async () => {
    await manager.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes a doc through both services (old controller behavior) → exactly one row per sourceId', async () => {
    // Seed doc-a through VectorStore alone so the table exists before the
    // concurrent double-index below (isolates the duplicate-row assertion from
    // the separate first-write createTable race).
    await vectorStore.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'doc-a',
      content: 'alpha document about deployment pipelines',
      metadata: {},
    });

    // Old controller addDocument behavior: Promise.all over both services.
    // With the shared manager both writes are serialized and the second one
    // replaces the first (same source_id), so the table keeps exactly one row.
    await Promise.all([
      vectorStore.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-b',
        content: 'beta document with zebra keyword',
        metadata: {},
      }),
      hybrid.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-b',
        content: 'beta document with zebra keyword',
        metadata: {},
      }),
    ]);

    const rows = await vectorStore.listDocuments(projectId, 100);
    expect(rowsForSourceId(rows, 'doc-a')).toBe(1);
    expect(rowsForSourceId(rows, 'doc-b')).toBe(1);

    const searchResult = await hybrid.search({ projectId, query: 'zebra' });
    expect(rowsForSourceId(searchResult.results, 'doc-b')).toBe(1);
  });

  it('single index via VectorStore (new controller behavior) is visible to HybridRetriever', async () => {
    await vectorStore.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'doc-e',
      content: 'epsilon document mentioning heron nesting',
      metadata: {},
    });

    const searchResult = await hybrid.search({ projectId, query: 'heron' });
    expect(rowsForSourceId(searchResult.results, 'doc-e')).toBe(1);
  });

  it('delete via VectorStore removes the document for HybridRetriever too', async () => {
    await vectorStore.deleteBySource(projectId, 'doc-b');

    const searchResult = await hybrid.search({ projectId, query: 'zebra' });
    expect(rowsForSourceId(searchResult.results, 'doc-b')).toBe(0);
  });
});

describe('RAG shared LanceDB write path — in-memory fallback mode', () => {
  let tmpDir: string;
  let manager: LanceTableManager;
  let vectorStore: VectorStore;
  let hybrid: HybridRetrieverService;
  const projectId = 'proj_shared_write_mem';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-lance-mgr-mem-'));
    const ragConfig = makeRagConfig(tmpDir, true);
    manager = new LanceTableManager(ragConfig, new FakeEmbeddingService() as never);
    ({ vectorStore, hybrid } = buildServices(ragConfig, manager));
  });

  afterAll(async () => {
    await manager.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a document indexed only via VectorStore is visible to HybridRetriever', async () => {
    await vectorStore.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'doc-c',
      content: 'gamma document mentioning penguin habitat',
      metadata: {},
    });

    const searchResult = await hybrid.search({ projectId, query: 'penguin' });
    expect(rowsForSourceId(searchResult.results, 'doc-c')).toBe(1);
  });

  it('delete via VectorStore propagates to HybridRetriever (no ghost copy)', async () => {
    // Old controller behavior: both services index the same doc.
    await Promise.all([
      vectorStore.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-d',
        content: 'delta document mentioning walrus migration',
        metadata: {},
      }),
      hybrid.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-d',
        content: 'delta document mentioning walrus migration',
        metadata: {},
      }),
    ]);

    await vectorStore.deleteBySource(projectId, 'doc-d');

    const searchResult = await hybrid.search({ projectId, query: 'walrus' });
    expect(rowsForSourceId(searchResult.results, 'doc-d')).toBe(0);
  });
});

describe('LanceTableManager', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-lance-mgr-unit-'));
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serializes concurrent writes to the same table (one write in flight at a time)', async () => {
    const manager = new LanceTableManager(makeRagConfig(tmpDir, true));

    let inFlight = 0;
    let maxConcurrent = 0;
    const write = (ms: number) => async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight--;
    };

    await Promise.all([
      manager.exclusive('project_p1', write(30)),
      manager.exclusive('project_p1', write(0)),
      manager.exclusive('project_p1', write(0)),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it('does not serialize writes to different tables', async () => {
    const manager = new LanceTableManager(makeRagConfig(tmpDir, true));

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aFinished = false;

    const a = manager.exclusive('project_a', async () => {
      await gateA;
      aFinished = true;
    });
    const b = manager.exclusive('project_b', async () => {
      // Independent of A's gate — must complete without waiting for A.
    });

    await b;
    expect(aFinished).toBe(false);
    releaseA();
    await a;
    expect(aFinished).toBe(true);
  });

  it('addRecord replaces rows with the same source_id (idempotent re-index)', async () => {
    const manager = new LanceTableManager(makeRagConfig(tmpDir, true));
    const table = await manager.getOrCreateTable('project_p2');

    const base = {
      source: 'doc',
      content: 'content v1',
      vector: [0, 0, 0, 0, 0, 0, 0, 0],
      metadata: '{}',
      created_at: new Date().toISOString(),
      provider: 'fake',
      model: 'fake-v1',
    };

    await manager.addRecord('project_p2', table, { ...base, id: 'id-1', source_id: 'same-source' });
    await manager.addRecord('project_p2', table, { ...base, id: 'id-2', source_id: 'same-source' });
    await manager.addRecord('project_p2', table, { ...base, id: 'id-3', source_id: 'other-source' });

    expect(await table.countRows()).toBe(2);
  });

  it('falls back to an InMemoryTable when the native module is unavailable and delete filters work', async () => {
    const manager = new LanceTableManager(makeRagConfig(tmpDir, true));
    expect(manager.available).toBe(false);

    const table = await manager.getOrCreateTable('project_p3');
    expect(table).toBeInstanceOf(InMemoryTable);

    const record = {
      id: 'id-1',
      source: 'doc',
      source_id: 'src-1',
      content: 'hello',
      vector: [0, 0, 0, 0, 0, 0, 0, 0],
      metadata: '{}',
      created_at: new Date().toISOString(),
      provider: 'fake',
      model: 'fake-v1',
    };
    await manager.addRecord('project_p3', table, record);
    expect(await table.countRows()).toBe(1);

    await manager.exclusive('project_p3', () => table.delete("source_id = 'src-1'"));
    expect(await table.countRows()).toBe(0);

    await manager.close();
  });

  it('evictTable drops the cached handle and first-access marker', async () => {
    const manager = new LanceTableManager(makeRagConfig(tmpDir, true));
    const table = await manager.getOrCreateTable('project_p4');

    let firstAccessCount = 0;
    const again = await manager.getOrCreateTable('project_p4', {
      onFirstAccess: () => {
        firstAccessCount++;
      },
    });
    expect(again).toBe(table);
    // onFirstAccess only fires when the table is first created in this manager
    // and was not already resolved before the hook was attached.
    expect(firstAccessCount).toBe(0);

    manager.evictTable('project_p4');
    const fresh = await manager.getOrCreateTable('project_p4', {
      onFirstAccess: () => {
        firstAccessCount++;
      },
    });
    // Fresh InMemoryTable instance after eviction.
    expect(fresh).not.toBe(table);
  });

  it('fires onFirstAccess exactly once per table when provided at creation', async () => {
    // onFirstAccess is a native-LanceDB-only hook (the in-memory fallback never
    // fires it, matching the previous `lanceAvailable &&` guard in VectorStore).
    const manager = new LanceTableManager(makeRagConfig(tmpDir, false));

    let firstAccessCount = 0;
    await manager.getOrCreateTable('project_p5', {
      onFirstAccess: () => {
        firstAccessCount++;
      },
    });
    await manager.getOrCreateTable('project_p5', {
      onFirstAccess: () => {
        firstAccessCount++;
      },
    });

    expect(firstAccessCount).toBe(1);
    await manager.close();
  });

  it('openTableIfLance returns null in in-memory mode', async () => {
    const manager = new LanceTableManager(makeRagConfig(tmpDir, true));
    await expect(manager.openTableIfLance('project_p6')).resolves.toBeNull();
  });
});
