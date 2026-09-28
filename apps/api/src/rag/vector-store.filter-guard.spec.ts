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
  let deleteSpy: jest.SpyInstance;

  beforeEach(async () => {
    manager = new LanceTableManager(ragConfig);
    store = new VectorStore(ragConfig, undefined, undefined, undefined, undefined, undefined, manager);
    const table = await manager.getOrCreateTable('project_proj-1');
    deleteSpy = jest.spyOn(table, 'delete');
  });

  it.each([
    ['a quote', "abc' OR '1'='1"],
    ['a newline', 'abc\nxyz'],
    ['a DEL character', 'abc\u007fxyz'],
    ['an empty string', ''],
  ])('rejects a sourceId containing %s before touching LanceDB', async (_label, sourceId) => {
    await expect(store.deleteBySource('proj-1', sourceId)).rejects.toBeInstanceOf(ValidationAppException);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('accepts a path-like sourceId', async () => {
    await expect(store.deleteBySource('proj-1', 'src/rag/vector-store.ts::VectorStore')).resolves.toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith("source_id = 'src/rag/vector-store.ts::VectorStore'");
  });
});
