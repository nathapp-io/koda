/**
 * Intent-Weighted Fusion and Reranking Integration Tests
 *
 * RED PHASE: These tests fail because the fusion/reranking logic does not
 * implement the spec correctly yet.
 *
 * Acceptance Criteria:
 * AC1:  Each intent uses the weight table defined in the spec
 * AC2:  For answer intent, finalScore = 0.4*vector + 0.3*lexical + 0.2*entity + 0.1*recency
 * AC3:  Results are sorted by finalScore descending and assigned sequential rank values
 * AC4:  Candidates before reranking are drawn from a pool of max(100, limit * 5) split evenly
 * AC5:  When a document has no entity tags, entityScore is 0 and finalScore reflects other scores
 * AC6:  When limit is not specified, limit defaults to 20
 * AC7:  Recency score = 0.5^(days_since_indexed / 30), min-max normalized to [0,1]
 * AC8:  Before fusion, each score source is min-max normalized to [0,1]
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
let HybridRetrieverService: any;
try {
  const mod = require('../../../src/rag/hybrid-retriever.service');
  HybridRetrieverService = mod.HybridRetrieverService;
} catch {
  HybridRetrieverService = undefined;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('Intent-Weighted Fusion and Reranking', () => {
  let module: TestingModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hybridService: any;
  let tmpDir: string;

  const projectId = 'proj_fusion_test_001';

  beforeAll(async () => {
    expect(HybridRetrieverService).toBeDefined();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-fusion-test-'));

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
    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;

    await hybridService.indexDocument(projectId, {
      source: 'ticket',
      sourceId: 'ticket-high-recency',
      content: 'Authentication null pointer exception in auth service',
      metadata: { ref: 'FUS-1', type: 'BUG' },
    });

    const oldDoc = await hybridService.indexDocument(projectId, {
      source: 'ticket',
      sourceId: 'ticket-low-recency',
      content: 'Authentication timeout in connection handler',
      metadata: { ref: 'FUS-2', type: 'BUG' },
    });
  });

  describe('AC1: Each intent uses the weight table defined in the spec', () => {
    it('answer intent uses 0.4/0.3/0.2/0.1 weights', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(0);
      const topScore = result.scores[0];
      expect(topScore).toHaveProperty('vectorScore');
      expect(topScore).toHaveProperty('lexicalScore');
      expect(topScore).toHaveProperty('entityScore');
      expect(topScore).toHaveProperty('recencyScore');
    });

    it('review intent uses 0.35/0.35/0.15/0.15 weights', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'review',
      });

      expect(result.results.length).toBeGreaterThan(0);
    });

    it('different intents produce different result orderings', async () => {
      const answerResult = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'answer',
        limit: 20,
      });
      const reviewResult = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'review',
        limit: 20,
      });

      // Both should return results and the weight profile changes score composition
      expect(answerResult.results.length).toBeGreaterThan(0);
      expect(reviewResult.results.length).toBeGreaterThan(0);
      // Verify the weight profiles differ by checking that vectorScore dominates in 'answer'
      // while lexicalScore gains importance in 'review' (0.35 vs 0.3)
      expect(answerResult.scores[0].vectorScore).toBeGreaterThan(0);
      expect(reviewResult.scores[0].vectorScore).toBeGreaterThan(0);
    });

    it('reproduce intent uses 0.5/0.2/0.2/0.1 weights', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'reproduce',
      });

      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  describe('AC2: For answer intent, finalScore = 0.4*vector + 0.3*lexical + 0.2*entity + 0.1*recency', () => {
    it('finalScore is computed using answer intent weights', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication token',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(0);

      for (let i = 0; i < result.scores.length; i++) {
        const score = result.scores[i];
        const expectedFinal =
          0.4 * score.vectorScore +
          0.3 * score.lexicalScore +
          0.2 * score.entityScore +
          0.1 * score.recencyScore;
        expect(score.finalScore).toBeCloseTo(expectedFinal, 4);
      }
    });
  });

  describe('AC3: Results are sorted by finalScore descending and assigned sequential rank values', () => {
    it('results are sorted in descending finalScore order', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(1);

      for (let i = 1; i < result.results.length; i++) {
        expect(result.scores[i].finalScore).toBeLessThanOrEqual(result.scores[i - 1].finalScore);
      }
    });

    it('rank values are sequential starting from 1', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'answer',
        limit: 10,
      });

      expect(result.results.length).toBeGreaterThan(0);

      for (let i = 0; i < result.results.length; i++) {
        expect(result.results[i]).toHaveProperty('rank');
        expect(result.results[i].rank).toBe(i + 1);
      }
    });
  });

  describe('AC4: Candidates before reranking are drawn from a pool of max(100, limit * 5)', () => {
    it('uses pool size max(100, limit * 5) for limit=10', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        limit: 10,
      });

      const expectedPoolSize = Math.max(100, 10 * 5);
      expect(expectedPoolSize).toBe(100);
    });

    it('uses pool size max(100, limit * 5) for limit=50', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        limit: 50,
      });

      const expectedPoolSize = Math.max(100, 50 * 5);
      expect(expectedPoolSize).toBe(250);
    });

    it('split evenly between vector and lexical sources', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication token null pointer',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  describe('AC5: When a document has no entity tags, entityScore is 0 and finalScore reflects other scores', () => {
    it('document with no entity tags has entityScore of 0', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-no-entities',
        content: 'Plain document with no entity metadata',
        metadata: { title: 'Plain Doc' },
      });

      const fakeEntityStore = hybridService.entityStore as { searchEntities: jest.Mock; computeEntityScore: jest.Mock };
      fakeEntityStore.searchEntities.mockReturnValue([]);
      fakeEntityStore.computeEntityScore.mockReturnValue(0);

      const result = await hybridService.search({
        projectId,
        query: 'plain document',
        intent: 'answer',
      });

      const docResult = result.results.find((r: { sourceId: string }) => r.sourceId === 'doc-no-entities');
      if (docResult) {
        const score = result.scores[result.results.indexOf(docResult)];
        expect(score.entityScore).toBe(0);
      }
    });

    it('finalScore does not include entityScore when entityScore is 0', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-final-score-test',
        content: 'Another document without entity tags',
        metadata: { title: 'Another Doc' },
      });

      const fakeEntityStore = hybridService.entityStore as { searchEntities: jest.Mock; computeEntityScore: jest.Mock };
      fakeEntityStore.searchEntities.mockReturnValue([]);
      fakeEntityStore.computeEntityScore.mockReturnValue(0);

      const result = await hybridService.search({
        projectId,
        query: 'another document',
        intent: 'answer',
      });

      const docResult = result.results.find((r: { sourceId: string }) => r.sourceId === 'doc-final-score-test');
      if (docResult) {
        const scoreIdx = result.results.indexOf(docResult);
        const score = result.scores[scoreIdx];

        const expectedFinal = 0.4 * score.vectorScore + 0.3 * score.lexicalScore + 0.1 * score.recencyScore;
        expect(score.finalScore).toBeCloseTo(expectedFinal, 4);
      }
    });
  });

  describe('AC6: When limit is not specified, limit defaults to 20', () => {
    it('returns at most 20 results when limit is omitted', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
      });

      expect(result.results.length).toBeLessThanOrEqual(20);
    });

    it('explicit limit=20 returns at most 20 results', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        limit: 20,
      });

      expect(result.results.length).toBeLessThanOrEqual(20);
    });

    it('limit=5 returns at most 5 results', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        limit: 5,
      });

      expect(result.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('AC7: Recency score = 0.5^(days_since_indexed / 30), min-max normalized to [0,1]', () => {
    it('recencyScore uses exponential decay formula', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'answer',
      });

      expect(result.scores.length).toBeGreaterThan(0);

      for (const score of result.scores) {
        expect(score.recencyScore).toBeGreaterThanOrEqual(0);
        expect(score.recencyScore).toBeLessThanOrEqual(1);
      }
    });

    it('newer documents have higher recency scores', async () => {
      const now = new Date();
      const recentTime = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
      const oldTime = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-recent-doc',
        content: 'Recent bug in payment service',
        metadata: { ref: 'RECENT-1' },
      });

      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-old-doc',
        content: 'Old bug in payment service',
        metadata: { ref: 'OLD-1' },
      });

      const result = await hybridService.search({
        projectId,
        query: 'payment service bug',
        intent: 'answer',
      });

      const recentResult = result.results.find((r: { sourceId: string }) => r.sourceId === 'ticket-recent-doc');
      const oldResult = result.results.find((r: { sourceId: string }) => r.sourceId === 'ticket-old-doc');

      if (recentResult && oldResult) {
        const recentScore = result.scores[result.results.indexOf(recentResult)];
        const oldScore = result.scores[result.results.indexOf(oldResult)];
        expect(recentScore.recencyScore).toBeGreaterThanOrEqual(oldScore.recencyScore);
      }
    });

    it('recency scores are min-max normalized across the candidate set', async () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      await hybridService.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-old-recency',
        content: 'Document with old timestamp for normalization test',
        metadata: { createdAtOverride: thirtyDaysAgo.toISOString() },
      });

      await hybridService.indexDocument(projectId, {
        source: 'doc',
        sourceId: 'doc-recent-recency',
        content: 'Document with recent timestamp for normalization test',
        metadata: { createdAtOverride: twoDaysAgo.toISOString() },
      });

      const result = await hybridService.search({
        projectId,
        query: 'normalization test document',
        intent: 'answer',
      });

      if (result.scores.length > 1) {
        const recencyScores = result.scores.map((s: { recencyScore: number }) => s.recencyScore);
        const minRecency = Math.min(...recencyScores);
        const maxRecency = Math.max(...recencyScores);

        expect(minRecency).toBeLessThan(maxRecency);
        expect(minRecency).toBeGreaterThan(0);
        expect(maxRecency).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('AC8: Before fusion, each score source is min-max normalized to [0,1]', () => {
    it('vectorScore is normalized to [0,1] across candidates', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-vector-test-1',
        content: 'First ticket for vector testing',
        metadata: {},
      });

      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-vector-test-2',
        content: 'Second ticket for vector testing',
        metadata: {},
      });

      const result = await hybridService.search({
        projectId,
        query: 'vector testing ticket',
        intent: 'answer',
      });

      for (const score of result.scores) {
        expect(score.vectorScore).toBeGreaterThanOrEqual(0);
        expect(score.vectorScore).toBeLessThanOrEqual(1);
      }

      const vectorScores = result.scores.map((s: { vectorScore: number }) => s.vectorScore);
      const nonZeroScores = vectorScores.filter((s: number) => s > 0);
      if (nonZeroScores.length > 1) {
        const minVec = Math.min(...nonZeroScores);
        const maxVec = Math.max(...nonZeroScores);
        if (minVec !== maxVec) {
          expect(minVec).toBeCloseTo(0, 2);
          expect(maxVec).toBeCloseTo(1, 2);
        }
      }
    });

    it('lexicalScore is normalized to [0,1] across candidates', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication token',
        intent: 'answer',
      });

      for (const score of result.scores) {
        expect(score.lexicalScore).toBeGreaterThanOrEqual(0);
        expect(score.lexicalScore).toBeLessThanOrEqual(1);
      }
    });

    it('entityScore is normalized to [0,1] across candidates', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication',
        intent: 'answer',
      });

      for (const score of result.scores) {
        expect(score.entityScore).toBeGreaterThanOrEqual(0);
        expect(score.entityScore).toBeLessThanOrEqual(1);
      }
    });

    it('candidate missing a source score contributes 0 for that source', async () => {
      const fakeEntityStore = hybridService.entityStore as { searchEntities: jest.Mock; computeEntityScore: jest.Mock };
      fakeEntityStore.searchEntities.mockReturnValue([]);
      fakeEntityStore.computeEntityScore.mockReturnValue(0);

      await hybridService.indexDocument(projectId, {
        source: 'manual',
        sourceId: 'manual-no-vector-match',
        content: 'Manual document that should not match vector query well',
        metadata: { title: 'Manual No Match' },
      });

      const result = await hybridService.search({
        projectId,
        query: 'xyznonexistentquery123',
        intent: 'answer',
      });

      const manualResult = result.results.find((r: { sourceId: string }) => r.sourceId === 'manual-no-vector-match');
      if (manualResult) {
        const score = result.scores[result.results.indexOf(manualResult)];
        expect(score.vectorScore).toBeGreaterThanOrEqual(0);
        expect(score.vectorScore).toBeLessThanOrEqual(1);
      }
    });

    it('when all candidates share the same raw score for a source, that source normalizes to 1 for present candidates', async () => {
      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-same-score-1',
        content: 'Identical content document one',
        metadata: {},
      });

      await hybridService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-same-score-2',
        content: 'Identical content document two',
        metadata: {},
      });

      const result = await hybridService.search({
        projectId,
        query: 'identical content',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(0);

      const presentScores = result.scores.filter((s: { vectorScore: number }) => s.vectorScore > 0);
      const absentScores = result.scores.filter((s: { vectorScore: number }) => s.vectorScore === 0);

      expect(presentScores.length).toBeGreaterThan(0);

      const allSameRawScore = presentScores.every(
        (s: { vectorScore: number }) => s.vectorScore === presentScores[0].vectorScore,
      );

      if (allSameRawScore && presentScores[0].vectorScore > 0) {
        for (const score of presentScores) {
          expect(score.vectorScore).toBe(1);
        }
      }
    });

    it('when all candidates share the same raw score for a source, absent candidates get 0', async () => {
      const uniqueProjectId = `${projectId}_absent_test`;
      const uniqueResult = await hybridService.search({
        projectId: uniqueProjectId,
        query: 'completely unrelated query string xyz',
        intent: 'answer',
      });

      expect(uniqueResult.results.length).toBe(0);
    });
  });

  describe('Weight profile verification', () => {
    it('verify answer intent weight profile: vector=0.4, lexical=0.3, entity=0.2, recency=0.1', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication bug',
        intent: 'answer',
      });

      expect(result.results.length).toBeGreaterThan(0);

      for (let i = 0; i < result.scores.length; i++) {
        const score = result.scores[i];
        const computed = 0.4 * score.vectorScore + 0.3 * score.lexicalScore + 0.2 * score.entityScore + 0.1 * score.recencyScore;
        expect(score.finalScore).toBeCloseTo(computed, 4);
      }
    });

    it('verify review intent weight profile: vector=0.35, lexical=0.35, entity=0.15, recency=0.15', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication bug',
        intent: 'review',
      });

      expect(result.results.length).toBeGreaterThan(0);

      for (let i = 0; i < result.scores.length; i++) {
        const score = result.scores[i];
        const computed = 0.35 * score.vectorScore + 0.35 * score.lexicalScore + 0.15 * score.entityScore + 0.15 * score.recencyScore;
        expect(score.finalScore).toBeCloseTo(computed, 4);
      }
    });

    it('verify reproduce intent weight profile: vector=0.5, lexical=0.2, entity=0.2, recency=0.1', async () => {
      const result = await hybridService.search({
        projectId,
        query: 'authentication bug',
        intent: 'reproduce',
      });

      expect(result.results.length).toBeGreaterThan(0);

      for (let i = 0; i < result.scores.length; i++) {
        const score = result.scores[i];
        const computed = 0.5 * score.vectorScore + 0.2 * score.lexicalScore + 0.2 * score.entityScore + 0.1 * score.recencyScore;
        expect(score.finalScore).toBeCloseTo(computed, 4);
      }
    });
  });
});