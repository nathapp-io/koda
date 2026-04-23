/**
 * HybridRetrieverService Integration Tests
 *
 * RED PHASE: These tests fail because HybridRetrieverService does not exist yet.
 * Once src/rag/hybrid-retriever.service.ts is implemented, these tests should pass.
 *
 * Acceptance Criteria:
 * AC1:  HybridRetrieverService.search() accepts HybridSearchQuery and returns HybridSearchResult
 * AC2:  HybridSearchResult.scores contains one ScoreBreakdown per returned result
 * AC2a: Each ScoreBreakdown includes vectorScore, lexicalScore, entityScore, recencyScore, finalScore
 * AC3:  HybridSearchResult.retrievedAt is set to server timestamp at query time
 * AC4:  When intent is not recognized, answer weights are used
 * AC5:  When timeWindow is provided, results are filtered by indexed timestamp before scoring
 * AC6:  Default limit is 20; cap is 50
 * AC7:  ticketIds and repoRefs are accepted without error (Phase 2 no-filter)
 * AC8:  Never returns results whose sourceProjectId differs from requested projectId
 *
 * @see HybridRetrieverService
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

jest.setTimeout(30000);

class FakeEmbeddingService {
  readonly providerName = 'fake';
  readonly modelName = 'fake-v1';
  readonly dimensions = 8;

  async embed(text: string): Promise<number[]> {
    const vec = Array.from({ length: 8 }, (_, i) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) >>> 0;
      return ((h + i * 1000) % 200) / 200;
    });
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RED PHASE: HybridRetrieverService is not yet implemented.
 * Once src/rag/hybrid-retriever.service.ts is created, remove this fallback.
 */
let HybridRetrieverService: any;
try {
  const mod = require('../../../src/rag/hybrid-retriever.service');
  HybridRetrieverService = mod.HybridRetrieverService;
} catch {
  HybridRetrieverService = undefined;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('HybridRetrieverService integration', () => {
  let module: TestingModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hybridService: any;
  let tmpDir: string;

  const projectId = 'proj_hybrid_test_001';

  beforeAll(async () => {
    expect(HybridRetrieverService).toBeDefined();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-hybrid-test-'));

    module = await Test.createTestingModule({
      providers: [
        HybridRetrieverService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const config: Record<string, unknown> = {
                'rag.lancedbPath': tmpDir,
                'rag.inMemoryOnly': true,
                'rag.ftsIndexMode': 'simple',
                'rag.similarityHigh': 0.85,
                'rag.similarityMedium': 0.70,
                'rag.similarityLow': 0.50,
              };
              return config[key];
            },
          },
        },
      ],
    }).compile();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hybridService = module.get<any>(HybridRetrieverService);
    (hybridService as { embeddingService: FakeEmbeddingService }).embeddingService = new FakeEmbeddingService();
  });

  afterAll(async () => {
    if (module) await module.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await hybridService.indexDocument(projectId, {
      source: 'ticket',
      sourceId: 'ticket-001',
      content: 'Null pointer exception in auth service when token is missing',
      metadata: { ref: 'HYB-1', type: 'BUG', status: 'CLOSED' },
    });

    await hybridService.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'doc-001',
      content: 'Authentication guide: how to configure JWT tokens',
      metadata: { title: 'Auth Guide' },
    });

    await hybridService.indexDocument(projectId, {
      source: 'manual',
      sourceId: 'manual-001',
      content: 'Database connection pooling configuration and best practices',
      metadata: { title: 'DB Config' },
    });
  });

  describe('AC1: search accepts HybridSearchQuery and returns HybridSearchResult', () => {
    it('returns an object with results, scores, and retrievedAt', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication token',
      });

      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('scores');
      expect(result).toHaveProperty('retrievedAt');
      expect(Array.isArray(result.results)).toBe(true);
      expect(Array.isArray(result.scores)).toBe(true);
    });
  });

  describe('AC2: scores array contains ScoreBreakdown per result', () => {
    it('scores.length equals results.length', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        limit: 5,
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.scores.length).toBe(result.results.length);
    });

    it('each score has vectorScore, lexicalScore, entityScore, recencyScore, finalScore', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
      });

      expect(result.results.length).toBeGreaterThan(0);

      for (const score of result.scores) {
        expect(score).toHaveProperty('vectorScore');
        expect(score).toHaveProperty('lexicalScore');
        expect(score).toHaveProperty('entityScore');
        expect(score).toHaveProperty('recencyScore');
        expect(score).toHaveProperty('finalScore');
        expect(typeof score.vectorScore).toBe('number');
        expect(typeof score.lexicalScore).toBe('number');
        expect(typeof score.entityScore).toBe('number');
        expect(typeof score.recencyScore).toBe('number');
        expect(typeof score.finalScore).toBe('number');
      }
    });
  });

  describe('AC3: retrievedAt is server timestamp', () => {
    it('retrievedAt is an ISO string within a recent time window', async () => {
      const before = new Date();
      const result = await hybridService.search({
        projectId,
        query: 'auth',
      });
      const after = new Date();

      expect(result.retrievedAt).toBeDefined();
      const retrievedAt = new Date(result.retrievedAt);
      expect(retrievedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(retrievedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('AC4: unknown intent uses answer weights', () => {
    it('succeeds with an unrecognized intent without throwing', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        intent: 'totally_unknown_intent_xyz',
      });

      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  describe('AC5: timeWindow filters results before scoring', () => {
    it('returns results when timeWindow start is recent', async () => {
      const recentTime = new Date();
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        timeWindow: {
          start: recentTime.toISOString(),
        },
      });

      expect(result.results.length).toBeGreaterThan(0);
    });

    it('returns empty results when timeWindow excludes all documents', async () => {
      const farFuture = new Date(Date.now() + 86400 * 365 * 1000);
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        timeWindow: {
          start: farFuture.toISOString(),
        },
      });

      expect(result.results).toEqual([]);
    });
  });

  describe('AC6: default limit 20, cap 50', () => {
    it('returns at most 20 results when limit is omitted', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
      });

      expect(result.results.length).toBeLessThanOrEqual(20);
    });

    it('caps at 50 when limit exceeds 50', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        limit: 100,
      });

      expect(result.results.length).toBeLessThanOrEqual(50);
    });

    it('respects a valid limit within range', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        limit: 3,
      });

      expect(result.results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('AC7: ticketIds and repoRefs accepted without error (Phase 2 no-filter)', () => {
    it('accepts ticketIds array', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          ticketIds: ['ticket-001', 'ticket-002', 'ticket-003'],
        }),
      ).resolves.not.toThrow();
    });

    it('accepts repoRefs array', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          repoRefs: ['org/repo#123', 'org/repo#456'],
        }),
      ).resolves.not.toThrow();
    });

    it('accepts both ticketIds and repoRefs together', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          ticketIds: ['ticket-001'],
          repoRefs: ['org/repo#123'],
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('AC8: project scope enforcement', () => {
    it('never returns results with mismatched sourceProjectId', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
      });

      for (const r of result.results) {
        expect(r.provenance.sourceProjectId).toBe(projectId);
      }
    });
  });
});
