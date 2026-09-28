import type { IRagConfig } from '../config/rag.config';
import { HybridRetrieverService } from './hybrid-retriever.service';
import type { LanceRecord, LanceTableManager } from './lance-table-manager';
import type { EntityStore } from './entity-store';
import type { PrismaRagRepository } from './prisma-rag.repository';

const ragConfig = {
  lancedbPath: './unused',
  inMemoryOnly: false,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
  graphifyEnabledCacheTtlSec: 60,
} as IRagConfig;

export function row(id: string, content: string, extra: Partial<LanceRecord> = {}): LanceRecord {
  return {
    id,
    source: 'doc',
    source_id: `src-${id}`,
    content,
    vector: Array(8).fill(0),
    metadata: '{}',
    created_at: '2026-09-01T00:00:00.000Z',
    provider: 'fake',
    model: 'fake-v1',
    ...extra,
  };
}

/** A LanceDB table stub: `scanned` is what query().limit() returns (the first 500 rows). */
export function stubTable(opts: { scanned: LanceRecord[]; fts: LanceRecord[]; vector: LanceRecord[] }): unknown {
  return {
    countRows: jest.fn().mockResolvedValue(opts.scanned.length + 1000),
    query: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(opts.scanned) }),
    }),
    search: jest.fn().mockResolvedValue(opts.fts),
    vectorSearch: jest.fn().mockReturnValue({
      distanceType: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(opts.vector) }),
      }),
    }),
  };
}

export function stubManager(table: unknown): LanceTableManager {
  return {
    available: true,
    ensureStorage: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    getOrCreateTable: jest.fn().mockResolvedValue(table),
    addRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as LanceTableManager;
}

export function buildRetriever(table: unknown): HybridRetrieverService {
  const embedding = { embed: jest.fn().mockResolvedValue(Array(8).fill(0.1)), dimensions: 8, providerName: 'fake', modelName: 'fake-v1' };
  const entityStore = { searchEntities: jest.fn().mockReturnValue([]), computeEntityScore: jest.fn().mockReturnValue(0) };
  const ragRepo = { findProjectGraphifyEnabled: jest.fn().mockResolvedValue({ graphifyEnabled: false }) };
  return new HybridRetrieverService(
    ragConfig,
    embedding as never,
    entityStore as unknown as EntityStore,
    ragRepo as unknown as PrismaRagRepository,
    stubManager(table),
  );
}

describe('HybridRetrieverService scoring (M16)', () => {
  it('a row with an unparseable created_at does not turn scores into NaN', async () => {
    const good = row('good', 'alpha beta', { _distance: 0.1 });
    const bad = row('bad', 'alpha gamma', { _distance: 0.2, created_at: 'not-a-date' });
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [good, bad] }));

    const result = await retriever.search({ projectId: 'p', query: 'alpha' });

    expect(result.scores.every((s) => Number.isFinite(s.finalScore))).toBe(true);
    expect(result.scores.every((s) => Number.isFinite(s.recencyScore))).toBe(true);
    expect(result.results[0].id).toBe('good');
  });

  it('a timeWindow excludes a row whose created_at does not parse', async () => {
    const inWindow = row('in', 'alpha', { _distance: 0.1, created_at: '2026-09-10T00:00:00.000Z' });
    const unparseable = row('bad', 'alpha', { _distance: 0.1, created_at: 'not-a-date' });
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [inWindow, unparseable] }));

    const result = await retriever.search({
      projectId: 'p',
      query: 'alpha',
      timeWindow: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
    });

    expect(result.results.map((r) => r.id)).toEqual(['in']);
  });
});
