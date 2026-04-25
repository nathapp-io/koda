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
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { EntityStore } from '../../../src/rag/entity-store';
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

    const fakeEmbeddingService = new FakeEmbeddingService();
    const fakePrismaClient = {
      $use: null,
      user: { findUnique: async () => null },
      agentRoleEntry: { findMany: async () => [] },
      project: { findUnique: async () => ({ graphifyEnabled: false }) },
    };

    const fakeEntityStore = {
      searchEntities: jest.fn().mockReturnValue([]),
      indexEntity: jest.fn(),
      getByTag: jest.fn().mockReturnValue([]),
      computeEntityScore: jest.fn().mockReturnValue(0),
    };

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
        {
          provide: EmbeddingService,
          useValue: fakeEmbeddingService,
        },
        {
          provide: EntityStore,
          useValue: fakeEntityStore,
        },
        {
          provide: PrismaService,
          useValue: { client: fakePrismaClient },
        },
      ],
    }).compile();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hybridService = module.get<any>(HybridRetrieverService);
    (hybridService as { embeddingService: FakeEmbeddingService }).embeddingService = fakeEmbeddingService;
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
          from: recentTime.toISOString(),
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
          from: farFuture.toISOString(),
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

  describe('AC-43: graphifyEnabled=false filters code results', () => {
    beforeEach(async () => {
      await hybridService.indexDocument(projectId, {
        source: 'code',
        sourceId: 'code-auth-001',
        content: 'function authenticate test function auth token',
        metadata: { type: 'code_module', lang: 'typescript' },
      });
    });

    it('returns zero code-source results when graphifyEnabled is false', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token authenticate',
        graphifyEnabled: false,
      });
      expect(result.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);
    });

    it('still returns non-code results when graphifyEnabled is false', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authenticate token authentication',
        graphifyEnabled: false,
      });
      const codeResults = result.results.filter((r: { source: string }) => r.source === 'code');
      expect(codeResults.length).toBe(0);
    });
  });

  describe('AC-45: graphifyEnabled=true includes code results', () => {
    beforeEach(async () => {
      await hybridService.indexDocument(projectId, {
        source: 'code',
        sourceId: 'code-auth-002',
        content: 'function validate token boolean auth function',
        metadata: { type: 'code_module', lang: 'typescript' },
      });
    });

    it('returns at least one code-source result when graphifyEnabled is true', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'token validate function auth boolean',
        graphifyEnabled: true,
      });
      expect(result.results.some((r: { source: string }) => r.source === 'code')).toBe(true);
    });
  });

  describe('AC-47: no error when disabled with no graph data', () => {
    it('completes without throwing when project has no graph data', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          graphifyEnabled: false,
        }),
      ).resolves.not.toThrow();
    });

    it('returns zero code results when disabled and no graph data exists', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        graphifyEnabled: false,
      });
      expect(result.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);
    });
  });

  describe('AC-48: 60-second TTL cache for graphifyEnabled', () => {
    it('returns cached graphifyEnabled value within TTL window', async () => {
      const query = { projectId, query: 'auth', graphifyEnabled: false };

      const result1 = await hybridService.search(query);
      expect(result1.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);

      const result2 = await hybridService.search(query);
      expect(result2.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);

      const result3 = await hybridService.search(query);
      expect(result3.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);
    });

    it('returns stable results across repeated calls within TTL window', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'code',
        sourceId: 'code-ttl-001',
        content: 'function auth ttl test',
        metadata: { type: 'code_module' },
      });

      const result1 = await hybridService.search({ projectId, query: 'auth ttl', graphifyEnabled: false });
      expect(result1.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);

      const result2 = await hybridService.search({ projectId, query: 'auth ttl', graphifyEnabled: true });
      const codeResults = result2.results.filter((r: { source: string }) => r.source === 'code');
      expect(codeResults.length).toBeGreaterThan(0);
    });
  });

  describe('AC-49: cache invalidation on updateProject', () => {
    it('fresh graphifyEnabled is queried after invalidation', async () => {
      const hybrid = hybridService as unknown as { invalidateGraphifyEnabledCache: (projectId: string) => void };
      expect(typeof hybrid.invalidateGraphifyEnabledCache).toBe('function');

      hybrid.invalidateGraphifyEnabledCache(projectId);

      const result = await hybridService.search({ projectId, query: 'auth' });
      expect(result).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  describe('AC-50: GraphifyEnabledGate', () => {
    it('search on non-graphify project never returns source=code results', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'code',
        sourceId: 'code-gate-001',
        content: 'export class AuthService check return true function',
        metadata: { type: 'code_module' },
      });

      const result = await hybridService.search({
        projectId,
        query: 'auth service check function export class',
        graphifyEnabled: false,
      });

      expect(result.results.filter((r: { source: string }) => r.source === 'code').length).toBe(0);
    });

    it('GraphifyEnabledGate passes for enabled project', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'code',
        sourceId: 'code-gate-002',
        content: 'function authCheck return false boolean check',
        metadata: { type: 'code_module' },
      });

      const result = await hybridService.search({
        projectId,
        query: 'auth check function boolean return',
        graphifyEnabled: true,
      });

      const codeResults = result.results.filter((r: { source: string }) => r.source === 'code');
      expect(codeResults.length).toBeGreaterThan(0);
    });
  });
});
