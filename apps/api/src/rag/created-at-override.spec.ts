import type { MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import type { IRagConfig } from '../config/rag.config';
import { resolveCreatedAt } from './created-at-override';
import { VectorStore } from './vector-store.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { LanceTableManager } from './lance-table-manager';
import type { EntityStore } from './entity-store';
import type { PrismaRagRepository } from './prisma-rag.repository';

const fixedNow = (): Date => new Date('2026-09-28T00:00:00.000Z');

describe('resolveCreatedAt', () => {
  it('uses now when there is no override', () => {
    expect(resolveCreatedAt({}, fixedNow)).toEqual({ createdAt: '2026-09-28T00:00:00.000Z' });
    expect(resolveCreatedAt(undefined, fixedNow)).toEqual({ createdAt: '2026-09-28T00:00:00.000Z' });
  });

  it('accepts a parseable override and normalises it to ISO-8601', () => {
    expect(resolveCreatedAt({ createdAtOverride: '2020-03-07' }, fixedNow)).toEqual({
      createdAt: '2020-03-07T00:00:00.000Z',
    });
  });

  it.each([['not-a-date'], [''], [42], [null], [{}]])('ignores the override %p and reports it', (value) => {
    expect(resolveCreatedAt({ createdAtOverride: value }, fixedNow)).toEqual({
      createdAt: '2026-09-28T00:00:00.000Z',
      rejectedOverride: value,
    });
  });
});

const ragConfig = {
  lancedbPath: './lancedb-created-at-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
  graphifyEnabledCacheTtlSec: 60,
} as IRagConfig;

const embedding = {
  embed: vi.fn().mockResolvedValue(Array(8).fill(0.1)),
  providerName: 'fake',
  modelName: 'fake-v1',
  dimensions: 8,
};

describe('both KB write paths reject a bad createdAtOverride', () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('VectorStore.indexDocument stores a valid created_at and warns', async () => {
    const store = new VectorStore(ragConfig, embedding as never);
    await store.indexDocument('proj-1', {
      source: 'doc',
      sourceId: 'doc-1',
      content: 'hello',
      metadata: { createdAtOverride: 'not-a-date' },
    });
    const [doc] = await store.listDocuments('proj-1');
    expect(Number.isFinite(Date.parse(doc.createdAt))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('createdAtOverride'));
  });

  it('HybridRetrieverService.indexDocument stores a valid created_at and warns', async () => {
    const manager = new LanceTableManager(ragConfig);
    const retriever = new HybridRetrieverService(
      ragConfig,
      embedding as never,
      {} as EntityStore,
      {} as PrismaRagRepository,
      manager,
    );
    await retriever.indexDocument('proj-2', {
      source: 'doc',
      sourceId: 'doc-2',
      content: 'hello',
      metadata: { createdAtOverride: 'not-a-date' },
    });
    const table = await manager.getOrCreateTable('project_proj-2');
    const [stored] = await table.query().limit(10).toArray();
    expect(Number.isFinite(Date.parse(stored.created_at))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('createdAtOverride') }));
  });
});
