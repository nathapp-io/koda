import { VectorStore } from './vector-store.service';
import type { EmbeddingService } from './embedding.service';
import type { IRagConfig } from '../config/rag.config';
import type { KbDocumentWriteSession } from './rag.service';

const config: IRagConfig = {
  embeddingProvider: 'ollama', embeddingModel: 'fake', ollamaBaseUrl: '', openaiApiKey: '',
  lancedbPath: '', inMemoryOnly: true, ftsIndexMode: 'simple', similarityHigh: 0.85,
  similarityMedium: 0.7, similarityLow: 0.5, ftsOptimizeStrategy: 'counter',
  ftsOptimizeThreshold: 10, ftsOptimizeIntervalMs: 300000, graphifyEnabledCacheTtlSec: 60,
};
const doc = { source: 'manual' as const, sourceId: 's1', content: 'hello', metadata: {} };
describe('KB addition shared session', () => {
  let store: VectorStore;
  beforeEach(() => { store = new VectorStore(config, { embed: vi.fn().mockResolvedValue([1, 2]), providerName: 'fake', modelName: 'fake' } as unknown as EmbeddingService); });
  afterEach(async () => { await store.onModuleDestroy(); });
  it('indexes without reacquiring the held mutex, joins nested sessions, and expires the session', async () => {
    let captured: KbDocumentWriteSession | undefined;
    await store.withDocumentWriteLock('p1', async session => {
      captured = session;
      await store.indexDocument('p1', doc, [1, 2]);
      await store.withDocumentWriteLock('p1', async nested => { expect(nested).toBe(session); });
      const rows = await session.capturePair('manual', 's1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ content: 'hello', vector: [1, 2] });
      await store.indexDocument('p1', { ...doc, content: 'changed' }, [3, 4]);
      await session.restorePair('manual', 's1', rows);
      expect(await session.capturePair('manual', 's1')).toEqual(rows);
    });
    if (!captured) throw new Error('Session missing');
    await expect(captured.capturePair('manual', 's1')).rejects.toThrow('outside its lock');
  });
  it('fences all normal writers and deletion recovery until addition recovery resolves the receipt', async () => {
    store.blockDocumentWrites('p1', true);
    await expect(store.indexDocument('p1', doc, [1, 2])).rejects.toThrow('unresolved');
    await expect(store.deleteBySource('p1', 'manual', 's1')).rejects.toThrow('unresolved');
    await expect(store.withDocumentWriteLock('p1', async () => undefined, { recovery: true })).rejects.toThrow('unresolved');
    await store.withDocumentWriteLock('p1', async session => { await session.restorePair('manual', 's1', []); }, { recovery: true, additionRecovery: true });
    store.blockDocumentWrites('p1', false);
    await expect(store.indexDocument('p1', doc, [1, 2])).resolves.toEqual(expect.any(String));
  });
});
