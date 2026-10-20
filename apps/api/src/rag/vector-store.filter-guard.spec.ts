import type { MockInstance } from 'vitest';
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { IRagConfig } from '../config/rag.config';
import { VectorStore } from './vector-store.service';
import { LanceTableManager } from './lance-table-manager';

const ragConfig = {
  lancedbPath: './lancedb-filter-guard-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
} as IRagConfig;

describe('VectorStore.deleteBySource filter guard', () => {
  let manager: LanceTableManager;
  let store: VectorStore;
  let deleteSpy: MockInstance;

  beforeEach(async () => {
    manager = new LanceTableManager(ragConfig);
    store = new VectorStore(ragConfig, undefined, undefined, undefined, undefined, manager);
    const table = await manager.getOrCreateTable('project_proj-1');
    deleteSpy = vi.spyOn(table, 'delete');
  });

  it.each([
    ['a quote', "abc' OR '1'='1"],
    ['a newline', 'abc\nxyz'],
    ['a DEL character', 'abc\u007fxyz'],
    ['an empty string', ''],
  ])('rejects a sourceId containing %s before touching LanceDB', async (_label, sourceId) => {
    await expect(store.deleteBySource('proj-1', 'manual', sourceId)).rejects.toBeInstanceOf(ValidationAppException);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a quote', "x' OR 1=1"],
    ['a newline', 'source\nxyz'],
    ['an empty string', ''],
  ])('rejects a source containing %s before touching LanceDB', async (_label, source) => {
    await expect(store.deleteBySource('proj-1', source, 's1')).rejects.toBeInstanceOf(ValidationAppException);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('AC-6: an injection attempt in the sourceId throws and deletes nothing', async () => {
    await expect(store.deleteBySource('proj-1', 'manual', "x' OR 1=1")).rejects.toBeInstanceOf(ValidationAppException);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('accepts a path-like sourceId and deletes only that (source, sourceId) pair', async () => {
    await expect(
      store.deleteBySource('proj-1', 'code', 'src/rag/vector-store.ts::VectorStore'),
    ).resolves.toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith("source = 'code' AND source_id = 'src/rag/vector-store.ts::VectorStore'");
  });
});

describe('VectorStore.findSourceCreators filter guard (AC-10)', () => {
  let manager: LanceTableManager;
  let store: VectorStore;
  let querySpy: MockInstance;
  let countRowsSpy: MockInstance;

  beforeEach(async () => {
    manager = new LanceTableManager(ragConfig);
    store = new VectorStore(ragConfig, undefined, undefined, undefined, undefined, manager);
    const table = await manager.getOrCreateTable('project_proj-1');
    countRowsSpy = vi.spyOn(table, 'countRows');
    querySpy = vi.spyOn(table, 'query');
  });

  it.each([
    ['the sourceId', 'doc', "x' OR 1=1"],
    ['the source', "x' OR 1=1", 'd1'],
    ['an empty source', '', 'd1'],
    ['a control character in the sourceId', 'doc', 'a\nb'],
  ])('rejects %s without querying the table', async (_label, source, sourceId) => {
    await expect(store.findSourceCreators('proj-1', source, sourceId)).rejects.toBeInstanceOf(ValidationAppException);
    expect(querySpy).not.toHaveBeenCalled();
    expect(countRowsSpy).not.toHaveBeenCalled();
  });

  it('reads an empty table without querying a page it does not have', async () => {
    await expect(store.findSourceCreators('proj-1', 'doc', 'd1')).resolves.toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('answers one entry per matching row and never widens to another source', async () => {
    const table = await store.getOrCreateTable('proj-1');
    await table.add([
      {
        id: 'r1',
        source: 'doc',
        source_id: 'd1',
        content: 'first',
        vector: [],
        metadata: JSON.stringify({ kodaCreatedBy: { type: 'AGENT', id: 'a1' } }),
        created_at: new Date().toISOString(),
        provider: 'fake',
        model: 'fake-v1',
      },
      {
        id: 'r2',
        source: 'doc',
        source_id: 'd1',
        content: 'second',
        vector: [],
        metadata: JSON.stringify({}),
        created_at: new Date().toISOString(),
        provider: 'fake',
        model: 'fake-v1',
      },
      {
        id: 'r3',
        source: 'ticket',
        source_id: 'd1',
        content: 'other source, same id',
        vector: [],
        metadata: JSON.stringify({ kodaCreatedBy: { type: 'USER', id: 'u1' } }),
        created_at: new Date().toISOString(),
        provider: 'fake',
        model: 'fake-v1',
      },
    ]);

    const creators = await store.findSourceCreators('proj-1', 'doc', 'd1');

    expect(creators).toHaveLength(2);
    expect(creators).toEqual(expect.arrayContaining([{ type: 'AGENT', id: 'a1' }, null]));
  });
});
