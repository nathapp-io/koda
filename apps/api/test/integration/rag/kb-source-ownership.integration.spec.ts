/**
 * US-006 — knowledge-base rows are replaced and deleted by (source, source_id), and record their creator.
 *
 * Bug being closed (review C/SEC-1): `LanceTableManager.addRecord` and `VectorStore.deleteBySource` matched
 * `source_id` alone, so a KB write from any caller replaced the rows of *every* source that happened to share an
 * id — an agent or a Developer overwriting a row the ticket indexer or the code graph owned.
 *
 * Mode under test: BOTH. The `in-memory fallback` describe exercises `InMemoryTable` (compound-delete parsing and
 * `where` filtering); the `native LanceDB` describe exercises the real SQL predicates. If the native module cannot
 * load, `LanceTableManager` falls back to `InMemoryTable`, so the native describe still exercises the same
 * semantics through the fallback.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IRagConfig } from '../../../src/config/rag.config';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { LanceTableManager } from '../../../src/rag/lance-table-manager';

vi.setConfig({ testTimeout: 60000 });

class FakeEmbeddingService {
  readonly providerName = 'fake';
  readonly modelName = 'fake-v1';
  readonly dimensions = 8;

  async embed(text: string): Promise<number[]> {
    return Array.from({ length: 8 }, (_, i) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) >>> 0;
      return ((h + i * 1000) % 200) / 200;
    });
  }
}

function makeRagConfig(lancedbPath: string, inMemoryOnly: boolean): IRagConfig {
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

describe.each([
  ['in-memory fallback', true],
  ['native LanceDB', false],
])('KB rows keyed by (source, source_id) — %s', (mode, inMemoryOnly) => {
  let tmpDir: string;
  let manager: LanceTableManager;
  let store: VectorStore;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-kb-ownership-'));
    const ragConfig = makeRagConfig(tmpDir, inMemoryOnly);
    manager = new LanceTableManager(ragConfig, new FakeEmbeddingService() as never);
    store = new VectorStore(ragConfig, new FakeEmbeddingService() as never, undefined, undefined, undefined, manager);
  });

  afterAll(async () => {
    await manager.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC-1: two sources may share a source_id; each keeps its own row', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_ac1`;

    await store.indexDocument(projectId, { source: 'ticket', sourceId: 's1', content: 'ticket s1', metadata: {} });
    await store.indexDocument(projectId, { source: 'manual', sourceId: 's1', content: 'manual s1', metadata: {} });

    const rows = (await store.listDocuments(projectId, 100)).filter((doc) => doc.sourceId === 's1');

    expect(rows).toHaveLength(2);
    expect(rows.map((doc) => doc.source).sort()).toEqual(['manual', 'ticket']);
  });

  it('AC-2: re-indexing one source replaces only that source row', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_ac2`;

    await store.indexDocument(projectId, { source: 'ticket', sourceId: 's1', content: 'ticket s1', metadata: {} });
    await store.indexDocument(projectId, { source: 'manual', sourceId: 's1', content: 'v1', metadata: {} });
    await store.indexDocument(projectId, { source: 'manual', sourceId: 's1', content: 'v2', metadata: {} });

    const docs = await store.listDocuments(projectId, 100);
    const manual = docs.filter((doc) => doc.source === 'manual' && doc.sourceId === 's1');

    expect(manual).toHaveLength(1);
    expect(manual[0].content).toBe('v2');
    expect(docs.filter((doc) => doc.source === 'ticket' && doc.sourceId === 's1')).toHaveLength(1);
  });

  it('AC-3: deleteBySource removes only the named source row', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_ac3`;

    await store.indexDocument(projectId, { source: 'ticket', sourceId: 's1', content: 'ticket s1', metadata: {} });
    await store.indexDocument(projectId, { source: 'manual', sourceId: 's1', content: 'manual s1', metadata: {} });

    await store.deleteBySource(projectId, 'manual', 's1');

    const docs = await store.listDocuments(projectId, 100);
    expect(docs.filter((doc) => doc.source === 'manual' && doc.sourceId === 's1')).toHaveLength(0);
    expect(docs.filter((doc) => doc.source === 'ticket' && doc.sourceId === 's1')).toHaveLength(1);
  });

  it('AC-4: createdBy is recorded as the row creator and overrides caller-supplied metadata', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_ac4`;

    await store.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'd1',
      content: 'document with a creator',
      metadata: { kodaCreatedBy: { type: 'USER', id: 'u9' } },
      createdBy: { type: 'AGENT', id: 'a1' },
    });

    await expect(store.findSourceCreators(projectId, 'doc', 'd1')).resolves.toEqual([{ type: 'AGENT', id: 'a1' }]);

    const [row] = (await store.listDocuments(projectId, 100)).filter((doc) => doc.sourceId === 'd1');
    expect(row.metadata.kodaCreatedBy).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-5: a row indexed without createdBy answers [null], and an absent pair answers []', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_ac5`;

    await store.indexDocument(projectId, { source: 'doc', sourceId: 'd2', content: 'system row', metadata: {} });

    await expect(store.findSourceCreators(projectId, 'doc', 'd2')).resolves.toEqual([null]);
    await expect(store.findSourceCreators(projectId, 'doc', 'no-such-row')).resolves.toEqual([]);
    await expect(store.findSourceCreators(projectId, 'manual', 'd2')).resolves.toEqual([]);
  });

  it('AC-9: a caller-supplied kodaCreatedBy never becomes the row creator', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_ac9`;

    await store.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'd3',
      content: 'row with forged metadata',
      metadata: { kodaCreatedBy: { type: 'USER', id: 'u9' } },
    });

    await expect(store.findSourceCreators(projectId, 'doc', 'd3')).resolves.toEqual([null]);
  });

  /**
   * Branch fix B2: a valid source id may contain ` AND ` (no quotes, no control characters), and the pair predicate is
   * `source = 'doc' AND source_id = 'research AND development'`. The fallback parser split that value in half, so its
   * delete matched nothing: re-indexing duplicated the row, and `deleteBySource` answered success while the document
   * stayed indexed.
   */
  it('B2: replacement and deletion work for a source id that contains AND', async () => {
    const projectId = `kbown_${inMemoryOnly ? 'mem' : 'native'}_b2`;
    const sourceId = 'research AND development';

    await store.indexDocument(projectId, { source: 'doc', sourceId, content: 'v1', metadata: {} });
    await store.indexDocument(projectId, { source: 'ticket', sourceId, content: 'ticket row', metadata: {} });
    await store.indexDocument(projectId, { source: 'doc', sourceId, content: 'v2', metadata: {} });

    const docRows = (await store.listDocuments(projectId, 100)).filter((doc) => doc.source === 'doc' && doc.sourceId === sourceId);
    expect(docRows).toHaveLength(1);
    expect(docRows[0]?.content).toBe('v2');

    await store.deleteBySource(projectId, 'doc', sourceId);

    const after = await store.listDocuments(projectId, 100);
    expect(after.filter((doc) => doc.source === 'doc' && doc.sourceId === sourceId)).toHaveLength(0);
    expect(after.filter((doc) => doc.source === 'ticket' && doc.sourceId === sourceId)).toHaveLength(1);
  });
});
