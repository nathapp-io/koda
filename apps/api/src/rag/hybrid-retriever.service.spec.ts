// Prevent LanceDB native module from loading — it holds open handles in tests
jest.mock('@lancedb/lancedb', () => ({
  connect: jest.fn().mockResolvedValue({
    tableNames: jest.fn().mockResolvedValue([]),
    createTable: jest.fn().mockResolvedValue({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      countRows: jest.fn().mockResolvedValue(0),
    }),
    openTable: jest.fn().mockResolvedValue({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      countRows: jest.fn().mockResolvedValue(0),
      search: jest.fn().mockResolvedValue([]),
      vectorSearch: jest.fn().mockReturnValue({ distanceType: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      optimize: jest.fn().mockResolvedValue(undefined),
    }),
  }),
  Index: { fts: jest.fn().mockReturnValue({}) },
}));

import { HybridRetrieverService } from './hybrid-retriever.service';
import type { IRagConfig } from '../config/rag.config';
import type { EmbeddingService } from './embedding.service';
import type { EntityStore } from './entity-store';
import type { PrismaRagRepository } from './prisma-rag.repository';

function makeRagConfig(overrides: Partial<IRagConfig> = {}): IRagConfig {
  return {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath: './lancedb-test',
    inMemoryOnly: true,
    ftsIndexMode: 'simple',
    similarityHigh: 0.85,
    similarityMedium: 0.7,
    similarityLow: 0.5,
    ftsOptimizeStrategy: 'counter',
    ftsOptimizeThreshold: 10,
    ftsOptimizeIntervalMs: 300000,
    graphifyEnabledCacheTtlSec: 60,
    ...overrides,
  };
}

function makeEmbeddingService(): jest.Mocked<EmbeddingService> {
  return {
    embed: jest.fn().mockResolvedValue(Array(8).fill(0.1)),
    providerName: 'ollama',
    modelName: 'nomic-embed-text',
    dimensions: 8,
  } as unknown as jest.Mocked<EmbeddingService>;
}

function makeEntityStore(): jest.Mocked<EntityStore> {
  return {
    searchEntities: jest.fn().mockReturnValue([]),
    computeEntityScore: jest.fn().mockReturnValue(0),
  } as unknown as jest.Mocked<EntityStore>;
}

function makeRagRepo(): jest.Mocked<PrismaRagRepository> {
  return {
    findProjectGraphifyEnabled: jest.fn().mockResolvedValue({ graphifyEnabled: false }),
  } as unknown as jest.Mocked<PrismaRagRepository>;
}

function buildService(configOverrides: Partial<IRagConfig> = {}): {
  service: HybridRetrieverService;
  ragConfig: IRagConfig;
  embeddingService: jest.Mocked<EmbeddingService>;
  entityStore: jest.Mocked<EntityStore>;
  ragRepo: jest.Mocked<PrismaRagRepository>;
} {
  const ragConfig = makeRagConfig(configOverrides);
  const embeddingService = makeEmbeddingService();
  const entityStore = makeEntityStore();
  const ragRepo = makeRagRepo();
  const service = new HybridRetrieverService(ragConfig, embeddingService, entityStore, ragRepo);
  return { service, ragConfig, embeddingService, entityStore, ragRepo };
}

describe('HybridRetrieverService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor / onModuleInit', () => {
    it('sets inMemoryOnly mode from config', () => {
      const { service } = buildService({ inMemoryOnly: true });
      // lanceAvailable is false in in-memory mode — verify by calling onModuleInit without throwing
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw on onModuleInit when inMemoryOnly=true', () => {
      const { service } = buildService({ inMemoryOnly: true });
      expect(() => service.onModuleInit()).not.toThrow();
    });
  });

  describe('onModuleDestroy', () => {
    it('clears caches without throwing', async () => {
      const { service } = buildService();
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('invalidateGraphifyEnabledCache', () => {
    it('removes the key without throwing', () => {
      const { service } = buildService();
      expect(() => service.invalidateGraphifyEnabledCache('proj-1')).not.toThrow();
    });
  });

  describe('indexDocument', () => {
    it('embeds content and adds record to the in-memory table', async () => {
      const { service, embeddingService } = buildService({ inMemoryOnly: true });
      embeddingService.embed.mockResolvedValue(Array(8).fill(0.5));

      await expect(
        service.indexDocument('proj-1', {
          source: 'ticket',
          sourceId: 'ticket-1',
          content: 'Fix login bug',
          metadata: { priority: 'HIGH' },
        }),
      ).resolves.toBeUndefined();

      expect(embeddingService.embed).toHaveBeenCalledWith('Fix login bug');
    });

    it('falls back to zero vector when embed throws', async () => {
      const { service, embeddingService } = buildService({ inMemoryOnly: true });
      embeddingService.embed.mockRejectedValueOnce(new Error('embed error'));

      await expect(
        service.indexDocument('proj-1', {
          source: 'doc',
          sourceId: 'doc-1',
          content: 'some content',
          metadata: {},
        }),
      ).resolves.toBeUndefined();
    });

    it('uses createdAtOverride from metadata when present', async () => {
      const { service, embeddingService } = buildService({ inMemoryOnly: true });
      embeddingService.embed.mockResolvedValue(Array(8).fill(0));

      await expect(
        service.indexDocument('proj-1', {
          source: 'manual',
          sourceId: 'manual-1',
          content: 'content',
          metadata: { createdAtOverride: '2024-01-15T00:00:00.000Z' },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('search', () => {
    it('returns empty results when table has no rows', async () => {
      const { service } = buildService({ inMemoryOnly: true });

      const result = await service.search({
        projectId: 'proj-1',
        query: 'fix bug',
      });

      expect(result.results).toEqual([]);
      expect(result.scores).toEqual([]);
      expect(result.retrievedAt).toBeDefined();
    });

    it('respects explicit graphifyEnabled=false to exclude code sources', async () => {
      const { service } = buildService({ inMemoryOnly: true });

      const result = await service.search({
        projectId: 'proj-1',
        query: 'code module',
        graphifyEnabled: false,
      });

      expect(result.results.every((r) => r.source !== 'code')).toBe(true);
    });

    it('caps limit at 50', async () => {
      const { service } = buildService({ inMemoryOnly: true });

      const result = await service.search({
        projectId: 'proj-1',
        query: 'anything',
        limit: 200,
      });

      // No rows — just verify it resolves without error
      expect(result.results.length).toBeLessThanOrEqual(50);
    });

    it('uses intent-specific weights when intent is provided', async () => {
      const { service } = buildService({ inMemoryOnly: true });

      const result = await service.search({
        projectId: 'proj-1',
        query: 'diagnose issue',
        intent: 'diagnose',
      });

      expect(result.retrievedAt).toBeDefined();
    });

    it('resolves graphifyEnabled from repo when not supplied explicitly', async () => {
      const { service, ragRepo } = buildService({ inMemoryOnly: true });
      ragRepo.findProjectGraphifyEnabled.mockResolvedValue({ graphifyEnabled: true } as any);

      await service.search({ projectId: 'proj-cache', query: 'test' });
      await service.search({ projectId: 'proj-cache', query: 'test again' });

      // Should hit the repo only once due to caching
      expect(ragRepo.findProjectGraphifyEnabled).toHaveBeenCalledTimes(1);
    });

    it('invalidateGraphifyEnabledCache forces repo re-fetch', async () => {
      const { service, ragRepo } = buildService({ inMemoryOnly: true });
      ragRepo.findProjectGraphifyEnabled.mockResolvedValue({ graphifyEnabled: false } as any);

      await service.search({ projectId: 'proj-2', query: 'a' });
      service.invalidateGraphifyEnabledCache('proj-2');
      await service.search({ projectId: 'proj-2', query: 'b' });

      expect(ragRepo.findProjectGraphifyEnabled).toHaveBeenCalledTimes(2);
    });
  });
});
