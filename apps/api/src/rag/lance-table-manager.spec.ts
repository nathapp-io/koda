/**
 * Branch fix B2 — the in-memory fallback parses a compound predicate by its conjunctions only, never by splitting
 * quoted values.
 *
 * A KB row is keyed by `(source, source_id)` and both values are user input: `isSafeFilterValue` allows a source id
 * such as `research AND development` (no quotes, no control characters), so the fallback used to split the
 * `source = 'doc' AND source_id = 'research AND development'` predicate in the middle of its value, fail to parse
 * the tail, and silently do nothing. `InMemoryTable.delete` then kept the row: re-indexing a document added a
 * second copy, and `deleteBySource` answered 200 for a document that was still there.
 *
 * Every case runs against the in-memory fallback the manager builds when the native LanceDB module is unavailable
 * (`inMemoryOnly`), which is the mode the parse bug lived in.
 */
import { IRagConfig } from '../config/rag.config';
import { InMemoryTable, LanceTableManager, isSafeFilterValue, sourceRowFilter, type LanceRecord } from './lance-table-manager';

const ACTIVE_SOURCE_ID = 'research AND development';

function makeRagConfig(): IRagConfig {
  return {
    embeddingProvider: 'fake',
    embeddingModel: 'fake-v1',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath: 'in-memory',
    inMemoryOnly: true,
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

function record(over: Partial<LanceRecord> = {}): LanceRecord {
  return {
    id: 'r1',
    source: 'doc',
    source_id: 's1',
    content: 'row',
    vector: [0, 1],
    metadata: '{}',
    created_at: '2026-10-20T00:00:00.000Z',
    provider: 'fake',
    model: 'fake-v1',
    ...over,
  };
}

async function rowsOf(table: InMemoryTable): Promise<LanceRecord[]> {
  return (await table.query().limit(100).toArray()) as LanceRecord[];
}

describe('InMemoryTable compound predicates (B2)', () => {
  it('the AND-containing source id the fallback must handle is a filter-safe value, so it reaches the table', () => {
    expect(isSafeFilterValue(ACTIVE_SOURCE_ID)).toBe(true);
    expect(sourceRowFilter('doc', ACTIVE_SOURCE_ID)).toBe(`source = 'doc' AND source_id = '${ACTIVE_SOURCE_ID}'`);
  });

  it('delete removes the row whose source_id contains AND, and keeps the row that shares its prefix', async () => {
    const table = new InMemoryTable();
    await table.add([
      record({ id: 'r1', source: 'doc', source_id: ACTIVE_SOURCE_ID }),
      record({ id: 'r2', source: 'doc', source_id: 'research' }),
    ]);

    await table.delete(sourceRowFilter('doc', ACTIVE_SOURCE_ID));

    expect((await rowsOf(table)).map((row) => row.id)).toEqual(['r2']);
  });

  it('delete keeps a row of another source that shares the AND-containing id', async () => {
    const table = new InMemoryTable();
    await table.add([
      record({ id: 'r1', source: 'doc', source_id: ACTIVE_SOURCE_ID }),
      record({ id: 'r2', source: 'ticket', source_id: ACTIVE_SOURCE_ID }),
    ]);

    await table.delete(sourceRowFilter('doc', ACTIVE_SOURCE_ID));

    expect((await rowsOf(table)).map((row) => row.id)).toEqual(['r2']);
  });

  it('delete removes the rows of a source whose own name contains AND', async () => {
    const table = new InMemoryTable();
    await table.add([
      record({ id: 'r1', source: 'docs AND notes', source_id: 's1' }),
      record({ id: 'r2', source: 'docs', source_id: 's1' }),
    ]);

    await table.delete(sourceRowFilter('docs AND notes', 's1'));

    expect((await rowsOf(table)).map((row) => row.id)).toEqual(['r2']);
  });

  it('a where predicate narrows to the AND-containing source id instead of being skipped', async () => {
    const table = new InMemoryTable();
    await table.add([
      record({ id: 'r1', source: 'doc', source_id: ACTIVE_SOURCE_ID }),
      record({ id: 'r2', source: 'doc', source_id: 'research' }),
    ]);

    const rows = (await table.query().where(sourceRowFilter('doc', ACTIVE_SOURCE_ID)).limit(10).toArray()) as LanceRecord[];

    expect(rows.map((row) => row.id)).toEqual(['r1']);
  });

  it('a malformed predicate still deletes nothing rather than widening', async () => {
    const table = new InMemoryTable();
    await table.add([record({ id: 'r1' })]);

    await table.delete("source = 'doc' AND");

    expect((await rowsOf(table)).map((row) => row.id)).toEqual(['r1']);
  });
});

describe('LanceTableManager.addRecord over the fallback (B2)', () => {
  let manager: LanceTableManager;

  beforeEach(() => {
    manager = new LanceTableManager(makeRagConfig());
  });

  afterEach(async () => {
    await manager.close();
  });

  it('re-indexing an AND-containing source id replaces the row instead of duplicating it', async () => {
    const tableName = 'project_p1';
    const table = await manager.getOrCreateTable(tableName);

    await manager.addRecord(tableName, table, record({ id: 'v1', content: 'v1', source_id: ACTIVE_SOURCE_ID }));
    await manager.addRecord(tableName, table, record({ id: 'v2', content: 'v2', source_id: ACTIVE_SOURCE_ID }));

    const rows = await rowsOf(table);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('v2');
  });
});
