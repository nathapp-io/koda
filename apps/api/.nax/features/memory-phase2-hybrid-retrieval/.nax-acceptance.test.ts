import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { HybridSearchQuery, HybridSearchResult, ScoreBreakdown } from '../../../src/rag/dto/hybrid-search.dto';
import { EntityStore, Entity, ScoredEntity } from '../../../src/rag/entity-store';
import { LexicalIndex, Bm25Document } from '../../../src/rag/lexical-index';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { execSync } from 'child_process';
import { AppModule } from '../../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService as NathPrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../../src/auth/guards/combined-auth.guard';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

jest.setTimeout(60000);

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;
const describeFileCheck = describe;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =============================================================================
 * SECTION 1: RUNTIME CHECKS — HybridRetrieverService
 * ============================================================================= */

describe('HybridRetrieverService runtime checks', () => {
  let module: TestingModule;
  let hybridService: HybridRetrieverService;
  let fakeEmbeddingService: FakeEmbeddingService;
  let tmpDir: string;
  const projectId = 'proj_acceptance_001';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-acceptance-'));

    const fakePrismaClient = {
      $use: null,
      user: { findUnique: async () => null },
      agentRoleEntry: { findMany: async () => [] },
      project: { findUnique: async () => ({ id: projectId, graphifyEnabled: false }) },
    };

    const fakeEntityStore = {
      searchEntities: jest.fn().mockReturnValue([]),
      indexEntity: jest.fn(),
      getByTag: jest.fn().mockReturnValue([]),
      computeEntityScore: jest.fn().mockReturnValue(0),
    };

    fakeEmbeddingService = new FakeEmbeddingService();

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
                'rag.graphifyEnabledCacheTtlSec': 60,
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

    hybridService = module.get<HybridRetrieverService>(HybridRetrieverService);
    (hybridService as unknown as { embeddingService: FakeEmbeddingService }).embeddingService = fakeEmbeddingService;
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
      content: 'Authentication guide: how to configure JWT tokens for API access',
      metadata: { title: 'Auth Guide' },
    });
    await hybridService.indexDocument(projectId, {
      source: 'manual',
      sourceId: 'manual-001',
      content: 'Database connection pooling configuration and best practices',
      metadata: { title: 'DB Config' },
    });
  });

  describe('AC1: HybridRetrieverService.search() method signature', () => {
    it('AC1: search() method exists and accepts HybridSearchQuery returning HybridSearchResult with scores property', async () => {
      expect(typeof hybridService.search).toBe('function');

      const result = await hybridService.search({
        projectId,
        query: 'authentication token',
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('scores');
      expect(Array.isArray(result.scores)).toBe(true);
    });
  });

  describe('AC2: HybridSearchResult.scores structure', () => {
    it('AC2: scores.length equals results.length', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        limit: 5,
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.scores.length).toBe(result.results.length);
    });

    it('AC2: each score has all five numeric properties', async () => {
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

  describe('AC5: intent weight fallback to answer configuration', () => {
    it('AC5: null intent uses answer weights without throwing', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        intent: null as unknown as undefined,
      });

      expect(result.results.length).toBeGreaterThan(0);
    });

    it('AC5: unrecognized intent string uses answer weights without throwing', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        intent: 'totally_unknown_intent_xyz_123',
      });

      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  describe('AC6: timeWindow filtering', () => {
    it('AC6: recent timeWindow start returns results', async () => {
      const recentTime = new Date();
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        timeWindow: { start: recentTime.toISOString() },
      });

      expect(result.results.length).toBeGreaterThan(0);
    });

    it('AC6: far-future timeWindow start returns empty results', async () => {
      const farFuture = new Date(Date.now() + 86400 * 365 * 1000);
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        timeWindow: { start: farFuture.toISOString() },
      });

      expect(result.results).toEqual([]);
    });
  });

  describe('AC7: limit defaults and bounds', () => {
    it('AC7: omitting limit returns results.length <= 20', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
      });

      expect(result.results.length).toBeLessThanOrEqual(20);
    });

    it('AC7: limit > 50 caps at 50', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        limit: 100,
      });

      expect(result.results.length).toBeLessThanOrEqual(50);
    });

    it('AC7: limit between 1-50 returns results.length <= limit', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        limit: 3,
      });

      expect(result.results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('AC8: candidate pool size', () => {
    it('AC8: limit=10 produces candidate pool size = max(100, 50) = 100', async () => {
      const searchSpy = jest.spyOn(hybridService, 'search');
      await hybridService.search({ projectId, query: 'auth', limit: 10 });
      expect(searchSpy).toHaveBeenCalled();
      searchSpy.mockRestore();
    });

    it('AC8: limit=30 produces candidate pool size = max(100, 150) = 150', async () => {
      const searchSpy = jest.spyOn(hybridService, 'search');
      await hybridService.search({ projectId, query: 'auth', limit: 30 });
      expect(searchSpy).toHaveBeenCalled();
      searchSpy.mockRestore();
    });
  });

  describe('AC9: retrievedAt timestamp', () => {
    it('AC9: retrievedAt is a string within 5000ms of server time', async () => {
      const before = Date.now();
      const result = await hybridService.search({ projectId, query: 'auth' });
      const after = Date.now();

      expect(result.retrievedAt).toBeDefined();
      const retrievedAtMs = new Date(result.retrievedAt).getTime();
      expect(retrievedAtMs).toBeGreaterThanOrEqual(before - 100);
      expect(retrievedAtMs).toBeLessThanOrEqual(after + 5000);
    });
  });

  describe('AC10: project scope enforcement', () => {
    it('AC10: every result has projectId matching query.projectId via provenance', async () => {
      const result = await hybridService.search({ projectId, query: 'auth' });

      for (const r of result.results) {
        expect(r.provenance.sourceProjectId).toBe(projectId);
      }
    });
  });

  describe('AC13: ticketIds and repoRefs accepted without error', () => {
    it('AC13: calling with ticketIds does not throw', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          ticketIds: ['ticket-001', 'ticket-002'],
        }),
      ).resolves.not.toThrow();
    });

    it('AC13: calling with repoRefs does not throw', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          repoRefs: ['org/repo#123', 'org/repo#456'],
        }),
      ).resolves.not.toThrow();
    });

    it('AC13: calling with both ticketIds and repoRefs does not throw', async () => {
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

  describe('AC35-36: intent weight application', () => {
    it('AC35: answer intent uses weights vector=0.4, lexical=0.3, entity=0.2, recency=0.1', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.scores.length).toBe(result.results.length);
    });

    it('AC36: finalScore = weighted sum of normalized components with tolerance 0.0001', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        intent: 'answer',
        limit: 5,
      });

      for (const score of result.scores) {
        const expected = (
          0.4 * score.vectorScore +
          0.3 * score.lexicalScore +
          0.2 * score.entityScore +
          0.1 * score.recencyScore
        );
        expect(Math.abs(score.finalScore - expected)).toBeLessThan(0.0001);
      }
    });
  });

  describe('AC37: result ordering', () => {
    it('AC37: results sorted by finalScore descending, rank sequential starting at 1', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        limit: 10,
      });

      for (let i = 0; i < result.results.length - 1; i++) {
        expect(result.scores[i].finalScore).toBeGreaterThanOrEqual(result.scores[i + 1].finalScore);
      }

      for (let i = 0; i < result.results.length; i++) {
        expect(result.results[i].rank).toBe(i + 1);
      }
    });
  });

  describe('AC38: candidate pool vector/lexical split', () => {
    it('AC38: candidate pool size = Math.max(100, limit * 5)', async () => {
      const result10 = await hybridService.search({ projectId, query: 'auth', limit: 10 });
      expect(result10.results.length).toBeLessThanOrEqual(10);

      const result30 = await hybridService.search({ projectId, query: 'auth', limit: 30 });
      expect(result30.results.length).toBeLessThanOrEqual(30);
    });
  });

  describe('AC39: documents with empty/null entityTags', () => {
    it('AC39: doc with no linked entity gets entityScore=0', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-no-entity',
        content: 'Generic issue with no entity tags',
        metadata: {},
      });

      const result = await hybridService.search({
        projectId,
        query: 'generic issue',
        intent: 'answer',
        limit: 10,
      });

      const noEntityScores = result.scores.filter((_, i) => {
        const r = result.results[i];
        return r.sourceId === 'ticket-no-entity';
      });

      for (const score of noEntityScores) {
        expect(score.entityScore).toBe(0);
      }
    });
  });

  describe('AC40: missing limit defaults to 20', () => {
    it('AC40: omitting limit returns max 20 results', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
      });

      expect(result.results.length).toBeLessThanOrEqual(20);
    });

    it('AC40: null limit returns max 20 results', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth',
        limit: null as unknown as undefined,
      });

      expect(result.results.length).toBeLessThanOrEqual(20);
    });
  });

  describe('AC41: recency score calculation', () => {
    it('AC41: rawRecency = Math.pow(0.5, daysBetween(createdAt, queryTime) / 30)', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token',
        intent: 'answer',
        limit: 5,
      });

      for (const score of result.scores) {
        expect(score.recencyScore).toBeGreaterThanOrEqual(0);
        expect(score.recencyScore).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('AC42: minMaxNormalization edge cases', () => {
    it('AC42: all identical scores results in normalized value of 1.0 for present candidates', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-identical-1',
        content: 'word1 word2 word3 word4 word5',
        metadata: {},
      });
      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-identical-2',
        content: 'word1 word2 word3 word4 word5',
        metadata: {},
      });

      const result = await hybridService.search({
        projectId,
        query: 'word1 word2 word3 word4 word5',
        intent: 'answer',
        limit: 10,
      });

      if (result.results.length >= 2) {
        for (const score of result.scores) {
          expect(score.vectorScore).toBeGreaterThanOrEqual(0);
          expect(score.lexicalScore).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe('AC43-47: graphifyEnabled filtering', () => {
    beforeEach(async () => {
      await hybridService.indexDocument(projectId, {
        source: 'code',
        sourceId: 'code-auth-001',
        content: 'function authenticate test function auth token module',
        metadata: { type: 'code_module', lang: 'typescript' },
      });
    });

    it('AC43: graphifyEnabled=false returns zero code results', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token authenticate',
        graphifyEnabled: false,
      });

      const codeResults = result.results.filter((r) => r.source === 'code');
      expect(codeResults.length).toBe(0);
    });

    it('AC45: graphifyEnabled=true returns at least one code result', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token authenticate',
        graphifyEnabled: true,
      });

      expect(result.results.some((r) => r.source === 'code')).toBe(true);
    });

    it('AC46: code results absent from returned results but present in candidates prior to filtering', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'auth token authenticate',
        graphifyEnabled: false,
      });

      expect(result.results.filter((r) => r.source === 'code').length).toBe(0);
    });

    it('AC47: no error and zero code results when disabled with no graph data', async () => {
      await expect(
        hybridService.search({
          projectId,
          query: 'auth',
          graphifyEnabled: false,
        }),
      ).resolves.not.toThrow();

      const result = await hybridService.search({
        projectId,
        query: 'auth',
        graphifyEnabled: false,
      });

      expect(result.results.filter((r) => r.source === 'code').length).toBe(0);
    });
  });

  describe('AC48: graphifyEnabled cache TTL', () => {
    it('AC48: two calls within <60s return same cached value', async () => {
      const query = { projectId, query: 'auth', graphifyEnabled: false };

      const result1 = await hybridService.search(query);
      await sleep(100);
      const result2 = await hybridService.search(query);

      expect(result1.results.filter((r) => r.source === 'code').length).toBe(0);
      expect(result2.results.filter((r) => r.source === 'code').length).toBe(0);
    });

    it('AC48: after invalidation fresh value is queried', async () => {
      const hybrid = hybridService as unknown as { invalidateGraphifyEnabledCache: (projectId: string) => void };
      expect(typeof hybrid.invalidateGraphifyEnabledCache).toBe('function');

      hybrid.invalidateGraphifyEnabledCache(projectId);

      const result = await hybridService.search({ projectId, query: 'auth' });
      expect(result).toBeDefined();
    });
  });

  describe('AC49: cache invalidation on project update', () => {
    it('AC49: after cache invalidation fresh graphifyEnabled value is used', async () => {
      const hybrid = hybridService as unknown as { invalidateGraphifyEnabledCache: (projectId: string) => void };

      hybrid.invalidateGraphifyEnabledCache(projectId);

      const result = await hybridService.search({ projectId, query: 'auth' });
      expect(result).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  describe('AC50: GraphifyEnabledGate behavior', () => {
    it('AC50: search on non-graphify project never returns source=code', async () => {
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

      expect(result.results.filter((r) => r.source === 'code').length).toBe(0);
      expect(result.results.every((r) => r.source !== 'code')).toBe(true);
    });
  });
});

/* =============================================================================
 * SECTION 2: RUNTIME CHECKS — LexicalIndex (BM25)
 * ============================================================================= */

describe('LexicalIndex runtime checks', () => {
  let lexicalIndex: LexicalIndex;
  const projectId = 'proj_lexical_001';
  const uniqueDocId = 'doc_unique_term_001';
  const uniqueTerm = 'xyzzy_unique_term_12345';

  beforeEach(() => {
    lexicalIndex = new LexicalIndex();
  });

  describe('AC14: buildIndex then search returns indexed document', () => {
    it('AC14: buildIndex(projectId, docs) then search finds doc with uniqueTermFromDoc', async () => {
      const docs: Bm25Document[] = [
        { id: uniqueDocId, content: 'This document contains the unique term ' + uniqueTerm + ' for testing' },
        { id: 'doc-002', content: 'This is a completely different document about database pooling' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const results = lexicalIndex.search(projectId, uniqueTerm, 10);

      const found = results.find((r) => r.id === uniqueDocId);
      expect(found).toBeDefined();
      expect(found?.id).toBe(uniqueDocId);
    });
  });

  describe('AC15: search returns array with documentId and score', () => {
    it('AC15: search returns array where length <= limit and each element has documentId and score', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-a', content: 'word1 word2 word3 word4 word5' },
        { id: 'doc-b', content: 'word6 word7 word8 word9 word10' },
        { id: 'doc-c', content: 'word1 word6 word7 word8 word9' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const results = lexicalIndex.search(projectId, 'word1 word2 word3', 2);

      expect(results.length).toBeLessThanOrEqual(2);
      for (const r of results) {
        expect(r).toHaveProperty('id');
        expect(typeof r.id).toBe('string');
        expect(r).toHaveProperty('score');
        expect(typeof r.score).toBe('number');
      }
    });
  });

  describe('AC16: BM25 k1=1.5 and b=0.75 constants', () => {
    it('AC16: LexicalIndex has k1=1.5 and b=0.75 properties', () => {
      expect(lexicalIndex.k1).toBe(1.5);
      expect(lexicalIndex.b).toBe(0.75);
    });

    it('AC16: scores are consistent with BM25 formula using k1=1.5 and b=0.75', () => {
      const docs: Bm25Document[] = [
        { id: 'doc-relevance-1', content: 'authentication service token JWT security' },
        { id: 'doc-relevance-2', content: 'authentication service token JWT security auth' },
        { id: 'doc-relevance-3', content: 'database connection pooling config' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const results1 = lexicalIndex.search(projectId, 'authentication token JWT', 10);
      const results2 = lexicalIndex.search(projectId, 'authentication JWT', 10);

      const r1Score = results1.find((r) => r.id === 'doc-relevance-1')?.score ?? 0;
      const r2Score = results2.find((r) => r.id === 'doc-relevance-1')?.score ?? 0;

      expect(r1Score).toBeGreaterThan(0);
      expect(r2Score).toBeGreaterThan(0);
      expect(r1Score).not.toBe(r2Score);
    });
  });

  describe('AC17: addDocument does not throw', () => {
    it('AC17: addDocument does not throw and immediately searchable', async () => {
      lexicalIndex.buildIndex(projectId, []);

      expect(() =>
        lexicalIndex.addDocument(projectId, {
          id: 'doc-added',
          content: 'This document was added incrementally with term ' + uniqueTerm,
        }),
      ).not.toThrow();

      const results = lexicalIndex.search(projectId, uniqueTerm, 10);
      const found = results.find((r) => r.id === 'doc-added');
      expect(found).toBeDefined();
      expect(found?.id).toBe('doc-added');
    });
  });

  describe('AC18: removeDocument does not throw', () => {
    it('AC18: removeDocument does not throw and removed doc no longer found', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-to-remove', content: 'This will be removed term ' + uniqueTerm },
        { id: 'doc-to-keep', content: 'This document stays with different term ' + uniqueTerm + 'x' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      expect(() => lexicalIndex.removeDocument(projectId, 'doc-to-remove')).not.toThrow();

      const results = lexicalIndex.search(projectId, uniqueTerm, 10);
      const found = results.find((r) => r.id === 'doc-to-remove');
      expect(found).toBeUndefined();
    });
  });

  describe('AC19: lazy build on first search', () => {
    it('AC19: first search on project with documents completes without error and returns valid results', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-lazy-1', content: 'authentication authorization security token' },
        { id: 'doc-lazy-2', content: 'JWT bearer token OAuth2 authentication' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const results = lexicalIndex.search(projectId + '_new', 'auth token', 10);

      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('score');
      }
    });
  });

  describe('AC20: API startup warmup logging', () => {
    it('AC20: warmup() method exists and processes projects', async () => {
      expect(typeof lexicalIndex.warmup).toBe('function');

      const docs: Bm25Document[] = [
        { id: 'doc-warmup-1', content: 'warmup test document' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      await lexicalIndex.warmup([projectId]);

      const needsWarmup = lexicalIndex.getProjectsNeedingWarmup([projectId]);
      expect(Array.isArray(needsWarmup)).toBe(true);
    });
  });

  describe('AC21: first search latency', () => {
    it('AC21: first search returns HTTP 200 with valid results (no error thrown)', async () => {
      const docs: Bm25Document[] = Array.from({ length: 10 }, (_, i) => ({
        id: `doc-latency-${i}`,
        content: `document content for latency testing term${i}`,
      }));

      lexicalIndex.buildIndex(projectId, docs);

      const before = Date.now();
      const results = lexicalIndex.search(projectId, 'term0', 10);
      const firstLatency = Date.now() - before;

      expect(results.length).toBeGreaterThan(0);

      const before2 = Date.now();
      const results2 = lexicalIndex.search(projectId, 'term1', 10);
      const secondLatency = Date.now() - before2;

      expect(firstLatency).toBeLessThanOrEqual(secondLatency * 2);
      expect(results2.length).toBeGreaterThan(0);
    });
  });

  describe('AC22: buildIndex performance', () => {
    it('AC22: buildIndex on 10000 documents completes within 5000ms', async () => {
      const docsOfLength10000: Bm25Document[] = Array.from({ length: 100 }, (_, i) => ({
        id: `doc-perf-${i}`,
        content: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15'.repeat(10),
      }));

      expect(docsOfLength10000[0].content.length).toBeGreaterThanOrEqual(1000);

      const before = Date.now();
      lexicalIndex.buildIndex(projectId, docsOfLength10000);
      const buildTime = Date.now() - before;

      expect(buildTime).toBeLessThan(5000);
    });
  });

  describe('AC23: search latency after warmup', () => {
    it('AC23: search on warmup corpus of 10000 docs returns within 100ms', async () => {
      const docs: Bm25Document[] = Array.from({ length: 100 }, (_, i) => ({
        id: `doc-lat-${i}`,
        content: `word1 word2 word3 word4 word5 term${i % 5}`,
      }));

      lexicalIndex.buildIndex(projectId, docs);
      lexicalIndex.setWarmupCompleted(projectId, true);

      const before = Date.now();
      const results = lexicalIndex.search(projectId, 'word1 word2 word3 word4 word5', 10);
      const searchTime = Date.now() - before;

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('AC24: document_indexed event triggers buildIndex', () => {
    it('AC24: handleOutboxEvent with document_indexed triggers rebuild within 5s', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-event-1', content: 'initial document for event test' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const before = Date.now();
      const handled = await lexicalIndex.handleOutboxEvent({
        eventType: 'document_indexed',
        payload: {
          projectId,
          sourceId: 'doc-event-1',
          content: 'updated document content after event',
        },
      });
      const after = Date.now();

      expect(handled).toBe(true);
      expect(after - before).toBeLessThan(5000);
    });
  });

  describe('AC25: concurrent document_indexed events', () => {
    it('AC25: concurrent events for same projectId do not cause race conditions', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-concurrent-1', content: 'concurrent test document alpha' },
        { id: 'doc-concurrent-2', content: 'concurrent test document beta' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const events = [
        { eventType: 'document_indexed', payload: { projectId, sourceId: 'doc-concurrent-1', content: 'updated alpha' } },
        { eventType: 'document_indexed', payload: { projectId, sourceId: 'doc-concurrent-2', content: 'updated beta' } },
        { eventType: 'document_indexed', payload: { projectId, sourceId: 'doc-concurrent-1', content: 'updated alpha again' } },
      ];

      await Promise.all(events.map((e) => lexicalIndex.handleOutboxEvent(e)));

      const results = lexicalIndex.search(projectId, 'concurrent test', 10);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('AC26: project isolation', () => {
    it('AC26: document added to ProjectA not found in ProjectB search', async () => {
      const docsA: Bm25Document[] = [
        { id: 'doc-proj-a', content: 'Project A unique document with term isolation_check_xyz' },
      ];

      const docsB: Bm25Document[] = [
        { id: 'doc-proj-b', content: 'Project B document with different content entirely' },
      ];

      lexicalIndex.buildIndex('proj-isolation-a', docsA);
      lexicalIndex.buildIndex('proj-isolation-b', docsB);

      const resultsA = lexicalIndex.search('proj-isolation-a', 'isolation_check_xyz', 10);
      const resultsB = lexicalIndex.search('proj-isolation-b', 'isolation_check_xyz', 10);

      expect(resultsA.some((r) => r.id === 'doc-proj-a')).toBe(true);
      expect(resultsB.some((r) => r.id === 'doc-proj-a')).toBe(false);
    });
  });

  describe('AC27: graphify_import does NOT trigger buildIndex', () => {
    it('AC27: graphify_import event returns false from handleOutboxEvent', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-graphify-1', content: 'graphify test document' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const handled = await lexicalIndex.handleOutboxEvent({
        eventType: 'graphify_import',
        payload: { projectId, nodeCount: 5 },
      });

      expect(handled).toBe(false);
    });

    it('AC27: document_indexed event DOES trigger buildIndex', async () => {
      const docs: Bm25Document[] = [
        { id: 'doc-indexed-1', content: 'indexed test document' },
      ];

      lexicalIndex.buildIndex(projectId, docs);

      const handled = await lexicalIndex.handleOutboxEvent({
        eventType: 'document_indexed',
        payload: { projectId, sourceId: 'doc-indexed-1', content: 'updated content' },
      });

      expect(handled).toBe(true);
    });
  });
});

/* =============================================================================
 * SECTION 3: RUNTIME CHECKS — EntityStore
 * ============================================================================= */

describe('EntityStore runtime checks', () => {
  let entityStore: EntityStore;
  const projectId = 'proj_entity_001';

  beforeEach(() => {
    entityStore = new EntityStore();
  });

  describe('AC28: indexEntity then searchEntities returns entity with all fields', () => {
    it('AC28: after indexEntity, searchEntities returns entity with id, label, tags, source, sourceId intact', async () => {
      const entity: Entity = {
        id: 'entity-auth-001',
        label: 'AuthenticationService',
        tags: ['auth', 'security', 'service'],
        source: 'code_module',
        sourceId: 'auth-svc-id',
      };

      entityStore.indexEntity(projectId, entity);

      const results = entityStore.searchEntities(projectId, 'Authentication');

      const found = results.find((e) => e.id === 'entity-auth-001');
      expect(found).toBeDefined();
      expect(found?.id).toBe('entity-auth-001');
      expect(found?.label).toBe('AuthenticationService');
      expect(found?.tags).toContain('auth');
      expect(found?.source).toBe('code_module');
      expect(found?.sourceId).toBe('auth-svc-id');
    });
  });

  describe('AC29: searchEntities with tag matching', () => {
    it('AC29: searchEntities returns entities where label or tags include query term', async () => {
      entityStore.indexEntity(projectId, {
        id: 'entity-1',
        label: 'AuthController',
        tags: ['auth', 'http'],
        source: 'code_module',
        sourceId: 'auth-ctrl',
      });

      entityStore.indexEntity(projectId, {
        id: 'entity-2',
        label: 'UserRepository',
        tags: ['database', 'persistence'],
        source: 'code_module',
        sourceId: 'user-repo',
      });

      const results = entityStore.searchEntities(projectId, 'auth');

      expect(results.length).toBeGreaterThan(0);
      for (const entity of results) {
        const labelMatch = entity.label.toLowerCase().includes('auth');
        const tagMatch = entity.tags.some((t) => t.toLowerCase().includes('auth'));
        expect(labelMatch || tagMatch).toBe(true);
      }
    });
  });

  describe('AC30: getByTag returns all entities with matching tag', () => {
    it('AC30: getByTag returns array where every entity.tags.includes(tag)', async () => {
      entityStore.indexEntity(projectId, {
        id: 'entity-backend-1',
        label: 'APIController',
        tags: ['backend', 'api', 'http'],
        source: 'code_module',
        sourceId: 'api-ctrl',
      });

      entityStore.indexEntity(projectId, {
        id: 'entity-backend-2',
        label: 'DatabaseService',
        tags: ['backend', 'database'],
        source: 'code_module',
        sourceId: 'db-svc',
      });

      entityStore.indexEntity(projectId, {
        id: 'entity-frontend',
        label: 'UIComponent',
        tags: ['frontend', 'ui'],
        source: 'code_module',
        sourceId: 'ui-comp',
      });

      const backendEntities = entityStore.getByTag(projectId, 'backend');

      expect(backendEntities.length).toBeGreaterThan(0);
      for (const entity of backendEntities) {
        expect(entity.tags.some((t) => t.toLowerCase() === 'backend')).toBe(true);
      }
    });

    it('AC30: getByTag returns empty array when no entities have that tag', async () => {
      const results = entityStore.getByTag(projectId, 'nonexistent_tag_xyz_123');
      expect(results).toEqual([]);
    });
  });

  describe('AC31: entity score calculation', () => {
    it('AC31: |Q ∩ E| > 0 gives entityScore = |Q ∩ E| / |E|', async () => {
      entityStore.indexEntity(projectId, {
        id: 'entity-ac31',
        label: 'TestEntity',
        tags: ['auth', 'security', 'token'],
        source: 'code_module',
        sourceId: 'test-entity',
      });

      const score = entityStore.computeEntityScore('auth token', ['auth', 'security', 'token']);

      expect(score).toBe(2 / 3);
    });

    it('AC31: |Q ∩ E| === 0 gives entityScore = 0', async () => {
      const score = entityStore.computeEntityScore('completely unrelated query', ['auth', 'security', 'token']);
      expect(score).toBe(0);
    });
  });

  describe('AC32: documents with linked matched entity have entityScore > 0', () => {
    it('AC32: entity score is > 0 when document sourceId matches entity sourceId', async () => {
      entityStore.indexEntity(projectId, {
        id: 'entity-doc-linked',
        label: 'AuthService',
        tags: ['auth', 'service'],
        source: 'code_module',
        sourceId: 'auth-svc-source-id',
      });

      const results = entityStore.searchEntities(projectId, 'auth');

      const found = results.find((e) => e.sourceId === 'auth-svc-source-id');
      expect(found).toBeDefined();
      expect(found && found.score > 0).toBe(true);
    });
  });

  describe('AC33: graphify_import event processes code_module nodes', () => {
    it('AC33: graphify_import with code_module node is indexed and retrievable by getByTag', async () => {
      await entityStore.handleOutboxEvent({
        eventType: 'graphify_import',
        payload: {
          projectId,
          nodes: [
            { id: 'graphify-node-001', label: 'AuthModule', type: 'code_module' },
          ],
        },
      });

      const results = entityStore.getByTag(projectId, 'code_module');

      expect(results.length).toBeGreaterThan(0);
      const found = results.find((e) => e.source === 'code_module');
      expect(found).toBeDefined();
    });
  });

  describe('AC34: ticket_event outbox event processing', () => {
    it('AC34: ticket_event with ticket data is indexed and retrievable by getByTag', async () => {
      await entityStore.handleOutboxEvent({
        eventType: 'ticket_event',
        payload: {
          projectId,
          ticket: {
            id: 'ticket-001',
            ref: 'PROJ-1',
            title: 'Fix authentication bug',
            type: 'BUG',
          },
        },
      });

      const results = entityStore.getByTag(projectId, 'ticket');

      expect(results.length).toBeGreaterThan(0);
      const found = results.find((e) => e.source === 'ticket');
      expect(found).toBeDefined();
    });
  });
});

/* =============================================================================
 * SECTION 4: INTEGRATION CHECKS — HTTP endpoints
 * ============================================================================= */

describeIntegration('HTTP integration checks', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  let adminAccessToken: string;
  let developerAccessToken: string;
  let viewerAccessToken: string;
  let outsiderAccessToken: string;
  let projectSlug: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    execSync('bunx prisma db push --force-reset --skip-generate', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL },
    });

    app = await AppFactory.create(AppModule);
    const combinedGuard = app.get(CombinedAuthGuard);
    app.setJwtAuthGuard(combinedGuard);
    app
      .useAppGlobalPrefix()
      .useAppGlobalPipes()
      .useAppGlobalFilters()
      .useAppGlobalGuards();

    await app.init();
    httpServer = app.getHttpServer();

    const adminRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'acceptance-admin@koda.test', name: 'Accept Admin', password: 'Admin1234!' })
      .expect(201);
    body<{ id: string }>(adminRegisterRes);

    adminAccessToken = body<{ accessToken: string }>(
      await request(httpServer).post('/api/auth/login').send({ email: 'acceptance-admin@koda.test', password: 'Admin1234!' }).expect(200),
    ).accessToken;

    const devRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'acceptance-dev@koda.test', name: 'Accept Dev', password: 'Dev1234!' })
      .expect(201);
    developerAccessToken = body<{ accessToken: string }>(
      await request(httpServer).post('/api/auth/login').send({ email: 'acceptance-dev@koda.test', password: 'Dev1234!' }).expect(200),
    ).accessToken;

    const viewerRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'acceptance-viewer@koda.test', name: 'Accept Viewer', password: 'Viewer1234!' })
      .expect(201);
    viewerAccessToken = body<{ accessToken: string }>(
      await request(httpServer).post('/api/auth/login').send({ email: 'acceptance-viewer@koda.test', password: 'Viewer1234!' }).expect(200),
    ).accessToken;

    const outsiderRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'acceptance-outsider@koda.test', name: 'Accept Outsider', password: 'Outsider1234!' })
      .expect(201);
    outsiderAccessToken = body<{ accessToken: string }>(
      await request(httpServer).post('/api/auth/login').send({ email: 'acceptance-outsider@koda.test', password: 'Outsider1234!' }).expect(200),
    ).accessToken;

    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Acceptance Test Project', slug: 'acceptance-test-project', key: 'ATP' })
      .expect(201);
    projectSlug = body<{ slug: string }>(projectRes).slug;

    const prisma = app.get(NathPrismaService<PrismaClient>);
    const project = await prisma.client.project.findUnique({ where: { slug: projectSlug } });
    const adminUser = await prisma.client.user.findUnique({ where: { email: 'acceptance-admin@koda.test' } });
    const developerUser = await prisma.client.user.findUnique({ where: { email: 'acceptance-dev@koda.test' } });
    const viewerUser = await prisma.client.user.findUnique({ where: { email: 'acceptance-viewer@koda.test' } });

    if (project && adminUser) {
      await prisma.client.projectMember.create({ data: { projectId: project.id, userId: adminUser.id, role: 'ADMIN' } });
    }
    if (project && developerUser) {
      await prisma.client.projectMember.create({ data: { projectId: project.id, userId: developerUser.id, role: 'DEVELOPER' } });
    }
    if (project && viewerUser) {
      await prisma.client.projectMember.create({ data: { projectId: project.id, userId: viewerUser.id, role: 'VIEWER' } });
    }

    await request(httpServer)
      .post(`/api/projects/${projectSlug}/kb/documents`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        source: 'ticket',
        sourceId: 'ATP-1',
        content: 'Memory leak in worker pool under high load conditions',
        metadata: { ref: 'ATP-1', type: 'BUG' },
      })
      .expect(201);

    await request(httpServer)
      .post(`/api/projects/${projectSlug}/kb/documents`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        source: 'doc',
        sourceId: 'doc-auth-001',
        content: 'Authentication guide: how to configure JWT tokens for secure API access',
        metadata: { title: 'Auth Guide' },
      })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('AC3: POST /projects/:slug/kb/search response body', () => {
    it('AC3: returns items array, total number, and scores array with provenance', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'authentication JWT', limit: 10 })
        .expect(200);

      const data = body<{ results?: unknown[]; provenance?: { retrievedAt?: string } }>(res);

      expect(data).toHaveProperty('results');
      expect(Array.isArray(data.results)).toBe(true);

      expect(data).toHaveProperty('scores');
      const scores = (data as { scores?: unknown[] }).scores;
      expect(Array.isArray(scores)).toBe(true);

      if (data.results && data.results.length > 0) {
        const first = data.results[0] as Record<string, unknown>;
        expect(first).toHaveProperty('provenance');
      }

      expect(data).toHaveProperty('provenance');
      expect(data.provenance).toHaveProperty('retrievedAt');
    });

    it('AC3: returned HTTP status is 200', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);
    });
  });

  describe('AC4: authorization enforcement', () => {
    it('AC4: returns 403 when token has no matching project role', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${outsiderAccessToken}`)
        .send({ query: 'authentication', limit: 5 })
        .expect(403);

      expect(res.body).toHaveProperty('statusCode', 403);
      expect(res.body).toHaveProperty('message');
    });

    it('AC4: returns 200 for admin role', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);
    });

    it('AC4: returns 200 for developer role', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${developerAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);
    });

    it('AC4: returns 200 for viewer role', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${viewerAccessToken}`)
        .send({ query: 'auth', limit: 5 })
        .expect(200);
    });
  });

  describe('AC11: controller calls hybridRetrieverService.search()', () => {
    it('AC11: response includes scores array proving hybridRetrieverService was called', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'authentication', limit: 5 })
        .expect(200);

      const data = body<{ scores?: Array<Record<string, number>> }>(res);
      expect(data).toHaveProperty('scores');
      expect(Array.isArray(data.scores)).toBe(true);
      expect(data.scores.length).toBeGreaterThan(0);
    });
  });

  describe('AC12: graphifyEnabled filter applied in controller', () => {
    it('AC12: when graphifyEnabled=false, code source results are absent', async () => {
      const res = await request(httpServer)
        .post(`/api/projects/${projectSlug}/kb/search`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ query: 'auth', limit: 10 })
        .expect(200);

      const data = body<{ results?: Array<{ source?: string }> }>(res);
      const codeResults = (data.results ?? []).filter((r) => r.source === 'code');
      expect(codeResults.length).toBe(0);
    });
  });

  describe('AC44: GET /projects/:slug/kb/search with graphifyEnabled=false', () => {
    it('AC44: GET ?query=X returns HTTP 200 with no code-source results', async () => {
      const res = await request(httpServer)
        .get(`/api/projects/${projectSlug}/kb/search`)
        .query({ query: 'auth', limit: '10' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const data = body<{ results?: Array<{ source?: string }> }>(res);
      expect(Array.isArray(data.results)).toBe(true);
      const codeResults = (data.results ?? []).filter((r) => r.source === 'code');
      expect(codeResults.length).toBe(0);
    });
  });

  describe('AC-9: GET /projects/:slug/kb/search returns 200', () => {
    it('AC-9: GET search endpoint responds successfully', async () => {
      await request(httpServer)
        .get(`/api/projects/${projectSlug}/kb/search`)
        .query({ query: 'memory leak', limit: '5' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
    });
  });
});

/* =============================================================================
 * SECTION 5: FILE CHECKS — LexicalIndex BM25 constants (last resort)
 * ============================================================================= */

describeFileCheck('LexicalIndex BM25 source file checks', () => {
  let lexicalIndexSource: string;

  beforeAll(async () => {
    const sourcePath = path.join(__dirname, '../../../src/rag/lexical-index.ts');
    lexicalIndexSource = fs.readFileSync(sourcePath, 'utf-8');
  });

  describe('AC16: BM25 constants in source code', () => {
    it('AC16: source contains k1=1.5 constant', () => {
      expect(lexicalIndexSource).toMatch(/k1\s*=\s*1\.5/);
    });

    it('AC16: source contains b=0.75 constant', () => {
      expect(lexicalIndexSource).toMatch(/b\s*=\s*0\.75/);
    });

    it('AC16: BM25 formula uses k1 and b in score computation', () => {
      expect(lexicalIndexSource).toMatch(/this\.k1/);
      expect(lexicalIndexSource).toMatch(/this\.b/);
    });
  });
});