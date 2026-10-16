import type { LanceRecord } from '../../rag/lance-table-manager';
import type { LanceTableManager } from '../../rag/lance-table-manager';
import {
  KnowledgeChunkStore,
  KnowledgeInvalidPathError,
  KnowledgeStoreUnavailableError,
} from './knowledge-chunk-store';

function fakeManager(available: boolean) {
  return {
    available,
    getOrCreateTable: vi.fn(),
    exclusive: vi.fn(),
  };
}

const row = (sourceId: string, chunkIndex: number): LanceRecord => ({
  id: `${sourceId}#${chunkIndex}`,
  source: 'repo',
  source_id: sourceId,
  content: 'c',
  vector: [0],
  metadata: JSON.stringify({ chunkIndex }),
  created_at: '2026-01-01T00:00:00.000Z',
  provider: 'fake',
  model: 'm',
});

describe('KnowledgeChunkStore', () => {
  it('readFile throws KnowledgeStoreUnavailableError when the manager is unavailable (AC-10)', async () => {
    const manager = fakeManager(false);
    const store = new KnowledgeChunkStore(manager as unknown as LanceTableManager);
    await expect(store.readFile('p1', 'repo:r1:docs/a.md')).rejects.toBeInstanceOf(KnowledgeStoreUnavailableError);
    expect(manager.getOrCreateTable).not.toHaveBeenCalled();
  });

  it.each(['replaceFile', 'deleteFile', 'lexical', 'vector'] as const)('%s throws when the manager is unavailable', async (method) => {
    const store = new KnowledgeChunkStore(fakeManager(false) as unknown as LanceTableManager);
    const call = {
      replaceFile: () => store.replaceFile('p1', 'repo:r1:docs/a.md', []),
      deleteFile: () => store.deleteFile('p1', 'repo:r1:docs/a.md'),
      lexical: () => store.lexical('p1', 'q', "source = 'repo'", 5),
      vector: () => store.vector('p1', [0], "source = 'repo'", 5),
    }[method];
    await expect(call()).rejects.toBeInstanceOf(KnowledgeStoreUnavailableError);
  });

  it("replaceFile rejects an unsafe sourceId and writes nothing (AC-15)", async () => {
    const manager = fakeManager(true);
    const store = new KnowledgeChunkStore(manager as unknown as LanceTableManager);
    const sourceId = "repo:r1:docs/it's.md";
    await expect(store.replaceFile('p1', sourceId, [row(sourceId, 0)])).rejects.toBeInstanceOf(KnowledgeInvalidPathError);
    expect(manager.getOrCreateTable).not.toHaveBeenCalled();
    expect(manager.exclusive).not.toHaveBeenCalled();
  });

  it('deleteFile and readFile reject an unsafe sourceId', async () => {
    const manager = fakeManager(true);
    const store = new KnowledgeChunkStore(manager as unknown as LanceTableManager);
    await expect(store.deleteFile('p1', "a'b")).rejects.toBeInstanceOf(KnowledgeInvalidPathError);
    await expect(store.readFile('p1', '')).rejects.toBeInstanceOf(KnowledgeInvalidPathError);
    expect(manager.exclusive).not.toHaveBeenCalled();
  });

  it('replaceFile rejects a row whose source_id differs from the file', async () => {
    const manager = fakeManager(true);
    const store = new KnowledgeChunkStore(manager as unknown as LanceTableManager);
    await expect(store.replaceFile('p1', 'repo:r1:a.md', [row('repo:r1:b.md', 0)])).rejects.toBeInstanceOf(KnowledgeInvalidPathError);
    expect(manager.exclusive).not.toHaveBeenCalled();
  });
});
