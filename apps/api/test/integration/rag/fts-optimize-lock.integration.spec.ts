/**
 * US-006: FTS optimize runs under the table's write lock.
 *
 * `LanceTableManager.exclusive` is a non-reentrant promise-chain mutex, and a KB write session
 * (`VectorStore.withDocumentWriteLock`) holds it for the whole session. The counter strategy reaches its
 * threshold *inside* that session, so a strategy that awaited `exclusive` itself would deadlock the write
 * session, while one that optimized through the raw table would race the table's writer.
 *
 * These specs hold a real write session on the real manager and index a document inside it. The manager and
 * the strategy are real; only the LanceDB table is a double, so the mutex ordering (and not a native module)
 * is what is under test.
 */
import { IRagConfig } from '../../../src/config/rag.config';
import { LanceTableManager } from '../../../src/rag/lance-table-manager';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { CounterOptimizeStrategy } from '../../../src/rag/strategies/counter-optimize.strategy';

const PROJECT_ID = 'p1';
const TABLE_NAME = `project_${PROJECT_ID}`;

function makeRagConfig(): IRagConfig {
  return {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath: './lancedb',
    inMemoryOnly: true,
    ftsIndexMode: 'simple',
    similarityHigh: 0.85,
    similarityMedium: 0.70,
    similarityLow: 0.50,
    ftsOptimizeStrategy: 'counter',
    ftsOptimizeThreshold: 1,
    ftsOptimizeIntervalMs: 300_000,
    graphifyEnabledCacheTtlSec: 60,
  };
}

function makeEmbedding() {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    providerName: 'test-provider',
    modelName: 'test-model',
    dimensions: 3,
  };
}

/** Rejects instead of hanging the whole file when the write session deadlocks. */
function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not resolve within 2s (deadlock)`)), 2000);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * A manager whose project table is a double, the counter strategy at threshold 1, and a warmed-up VectorStore
 * (the first-access hook has already fired, so only `indexDocument` can start an optimize afterwards).
 */
async function makeHeldSessionFixture() {
  const manager = new LanceTableManager(makeRagConfig());
  const table = {
    add: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn().mockResolvedValue(0),
    query: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
    optimize: vi.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).tableCache.set(TABLE_NAME, table);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).lanceAvailable = true;

  const strategy = new CounterOptimizeStrategy(makeRagConfig());
  const store = new VectorStore(
    makeRagConfig(),
    makeEmbedding() as never,
    strategy,
    undefined,
    undefined,
    manager,
  );

  // Warm up: the first-access hook optimizes once; drain it so the session assertions see only new work.
  await store.getOrCreateTable(PROJECT_ID);
  await vi.waitFor(() => expect(table.optimize).toHaveBeenCalledTimes(1));
  table.optimize.mockClear();

  return { manager, table, store };
}

const DOCUMENT = {
  source: 'doc' as const,
  sourceId: 'doc-1',
  content: 'document indexed inside a held write session',
  metadata: {},
};

describe('US-006: FTS optimize vs a held KB write session', () => {
  it('AC-12: indexDocument at the counter threshold inside a held session completes', async () => {
    const { manager, table, store } = await makeHeldSessionFixture();
    let indexResolvedInsideSession = false;

    try {
      await store.withDocumentWriteLock(PROJECT_ID, async () => {
        await withDeadline(store.indexDocument(PROJECT_ID, DOCUMENT), 'indexDocument');
        indexResolvedInsideSession = true;
        // The optimize it started is queued behind this very section, never run inside it.
        expect(table.optimize).not.toHaveBeenCalled();
      });

      // It did reach the optimize — once the session released the table.
      await vi.waitFor(() => expect(table.optimize).toHaveBeenCalledTimes(1));
    } finally {
      await manager.close();
    }

    expect(indexResolvedInsideSession).toBe(true);
  });

  it('AC-13: the queued optimize runs only after the held session ends', async () => {
    const { manager, table, store } = await makeHeldSessionFixture();
    const optimizePhaseWhenRun: string[] = [];
    // 'open' until the session's work finishes; the table is released when the session callback returns.
    let sessionPhase = 'open';
    table.optimize.mockImplementation(async () => {
      optimizePhaseWhenRun.push(sessionPhase);
    });

    try {
      await store.withDocumentWriteLock(PROJECT_ID, async () => {
        await withDeadline(store.indexDocument(PROJECT_ID, DOCUMENT), 'indexDocument');
        expect(table.optimize).not.toHaveBeenCalled();
        sessionPhase = 'closed';
      });

      await vi.waitFor(() => expect(table.optimize).toHaveBeenCalledTimes(1));

      expect(optimizePhaseWhenRun).toEqual(['closed']);
    } finally {
      await manager.close();
    }
  });

  // Control for AC-13: the phase assertion above only means something because an optimize that skips the table's
  // mutex — the pre-US-006 shape, where the strategy was handed the raw table — lands in the 'open' phase.
  it('detects the unlocked shape: optimizing from inside the session is observed as in-session', async () => {
    const { manager, table, store } = await makeHeldSessionFixture();
    const optimizePhaseWhenRun: string[] = [];
    let sessionPhase = 'open';
    table.optimize.mockImplementation(async () => {
      optimizePhaseWhenRun.push(sessionPhase);
    });

    try {
      await store.withDocumentWriteLock(PROJECT_ID, async () => {
        await table.optimize();
        expect(optimizePhaseWhenRun).toEqual(['open']);
        sessionPhase = 'closed';
      });
    } finally {
      await manager.close();
    }
  });
});
