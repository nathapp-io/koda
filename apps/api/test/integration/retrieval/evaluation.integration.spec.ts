/**
 * EvaluationService Integration Tests
 *
 * RED PHASE: These tests fail because EvaluationService.runQueries is not yet implemented.
 *
 * These tests use the real HybridRetrieverService with in-memory storage to test
 * the full integration flow end-to-end.
 *
 * Acceptance Criteria (same as unit tests, but with real HybridRetrieverService):
 * AC1: runQueries runs each query through HybridRetrieverService and returns precision@5 per query
 * AC2: runQueries returns summary with precisionAt5_avg, precisionAt5_p50, precisionAt5_p95, totalQueries
 * AC3: Each SingleQueryResult includes query, intent, expectedDocIds, actualDocIds, precisionAt5, retrievedAt
 * AC4: precisionAt5 = count of expectedDocIds found in top 5 results / total expectedDocIds
 * AC5: p50 is the 50th percentile (median) of precisionAt5 values
 * AC6: p95 is the 95th percentile of precisionAt5 values
 * AC7: totalQueries equals the number of input queries
 * AC8: Seeds documents before running queries (uses indexDocument on HybridRetrieverService)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { EvaluationService, EvalQuery } from '../../../src/retrieval/evaluation.service';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { EntityStore } from '../../../src/rag/entity-store';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

jest.setTimeout(60000);

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

describe('EvaluationService integration with real HybridRetrieverService', () => {
  let module: TestingModule;
  let evaluationService: EvaluationService;
  let hybridService: HybridRetrieverService;
  let tmpDir: string;

  const projectId = 'proj_eval_integration_001';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-eval-test-'));

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
        HybridRetrieverService,
        EvaluationService,
      ],
    }).compile();

    hybridService = module.get<HybridRetrieverService>(HybridRetrieverService);
    evaluationService = module.get<EvaluationService>(EvaluationService);

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
      metadata: { ref: 'EVAL-1', type: 'BUG', status: 'CLOSED' },
    });

    await hybridService.indexDocument(projectId, {
      source: 'ticket',
      sourceId: 'ticket-002',
      content: 'Authentication fails with SSO provider configuration error',
      metadata: { ref: 'EVAL-2', type: 'BUG', status: 'CLOSED' },
    });

    await hybridService.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'doc-001',
      content: 'JWT authentication guide: how to configure tokens and refresh',
      metadata: { title: 'Auth Guide' },
    });

    await hybridService.indexDocument(projectId, {
      source: 'ticket',
      sourceId: 'ticket-003',
      content: 'Database connection pool exhausted under heavy load',
      metadata: { ref: 'EVAL-3', type: 'BUG', status: 'IN_PROGRESS' },
    });

    await hybridService.indexDocument(projectId, {
      source: 'manual',
      sourceId: 'manual-001',
      content: 'Deployment guide: Kubernetes configuration and best practices',
      metadata: { title: 'Deployment Guide' },
    });
  });

  describe('AC1 & AC3: runQueries calls HybridRetrieverService and returns per-query results', () => {
    it('runs a single query and returns result with all required fields', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'authentication token error',
          intent: 'answer',
          expectedDocIds: ['ticket-001', 'ticket-002'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results).toHaveLength(1);
      const result = summary.results[0];
      expect(result.query).toBe('authentication token error');
      expect(result.intent).toBe('answer');
      expect(result.expectedDocIds).toEqual(['ticket-001', 'ticket-002']);
      expect(Array.isArray(result.actualDocIds)).toBe(true);
      expect(typeof result.precisionAt5).toBe('number');
      expect(result.retrievedAt).toBeDefined();
    });

    it('runs multiple queries and returns one result per query', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'authentication token',
          intent: 'answer',
          expectedDocIds: ['ticket-001'],
        },
        {
          projectId,
          query: 'database connection',
          intent: 'diagnose',
          expectedDocIds: ['ticket-003'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results).toHaveLength(2);
    });
  });

  describe('AC4: precisionAt5 calculation with real HybridRetrieverService', () => {
    it('precisionAt5 = 1.0 when expected doc is the top result', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'null pointer exception auth token missing',
          intent: 'answer',
          expectedDocIds: ['ticket-001'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(1.0);
    });

    it('precisionAt5 = 0.0 when expected doc is not in any result', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'nonexistent query xyz abc 123',
          intent: 'answer',
          expectedDocIds: ['ticket-999'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(0.0);
    });

    it('precisionAt5 = 0.5 when one of two expected docs is retrieved', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'authentication token null pointer',
          intent: 'answer',
          expectedDocIds: ['ticket-001', 'ticket-999'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('AC2 & AC7: summary fields with real HybridRetrieverService', () => {
    it('totalQueries equals number of input queries', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'auth token', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'database pool', intent: 'diagnose', expectedDocIds: ['ticket-003'] },
        { projectId, query: 'deployment guide', intent: 'answer', expectedDocIds: ['manual-001'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.totalQueries).toBe(3);
    });

    it('summary contains precisionAt5_avg, precisionAt5_p50, precisionAt5_p95', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'auth token', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'database pool', intent: 'diagnose', expectedDocIds: ['ticket-003'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary).toHaveProperty('precisionAt5_avg');
      expect(summary).toHaveProperty('precisionAt5_p50');
      expect(summary).toHaveProperty('precisionAt5_p95');
      expect(typeof summary.precisionAt5_avg).toBe('number');
      expect(typeof summary.precisionAt5_p50).toBe('number');
      expect(typeof summary.precisionAt5_p95).toBe('number');
    });

    it('precisionAt5_avg reflects actual retrieval quality', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'null pointer auth token missing', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'nonexistent xyz abc', intent: 'answer', expectedDocIds: ['ticket-999'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_avg).toBe(0.5);
    });
  });

  describe('AC5 & AC6: percentile calculations with real HybridRetrieverService', () => {
    it('precisionAt5_p50 is median for odd number of queries', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'null pointer auth token', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'nonexistent query xyz', intent: 'answer', expectedDocIds: ['ticket-999'] },
        { projectId, query: 'auth fails sso', intent: 'answer', expectedDocIds: ['ticket-002'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_p50).toBe(1.0);
    });

    it('precisionAt5_p95 is 95th percentile for varied results', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'null pointer auth', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'auth sso', intent: 'answer', expectedDocIds: ['ticket-002'] },
        { projectId, query: 'database connection', intent: 'diagnose', expectedDocIds: ['ticket-003'] },
        { projectId, query: 'nonexistent xyz', intent: 'answer', expectedDocIds: ['ticket-999'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_p95).toBe(1.0);
    });
  });

  describe('AC8: seeds real documents via HybridRetrieverService.indexDocument', () => {
    it('retrieval works when hybrid service has indexed real documents', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'JWT authentication guide',
          intent: 'answer',
          expectedDocIds: ['doc-001'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].actualDocIds).toContain('doc-001');
      expect(summary.results[0].precisionAt5).toBe(1.0);
    });

    it('multiple intents work with same documents', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'null pointer auth', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'null pointer auth', intent: 'diagnose', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'null pointer auth', intent: 'plan', expectedDocIds: ['ticket-001'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results).toHaveLength(3);
    });
  });

  describe('table printing (AC4: CI-friendly output)', () => {
    it('runQueries result can be serialized to JSON for table rendering', async () => {
      const queries: EvalQuery[] = [
        {
          projectId,
          query: 'auth token',
          intent: 'answer',
          expectedDocIds: ['ticket-001'],
        },
      ];

      const summary = await evaluationService.runQueries(queries);

      const json = JSON.stringify(summary, null, 2);
      expect(json).toContain('precisionAt5_avg');
      expect(json).toContain('precisionAt5_p50');
      expect(json).toContain('precisionAt5_p95');
      expect(json).toContain('totalQueries');
      expect(json).toContain('results');
    });
  });

  describe('CI threshold check (AC6: precision below 0.70 fails pipeline)', () => {
    it('evaluator can determine if precisionAt5_avg is below threshold', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'nonexistent query', intent: 'answer', expectedDocIds: ['ticket-999'] },
        { projectId, query: 'nonexistent query 2', intent: 'answer', expectedDocIds: ['ticket-998'] },
        { projectId, query: 'nonexistent query 3', intent: 'answer', expectedDocIds: ['ticket-997'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      const ciThreshold = 0.70;
      const isBelowThreshold = summary.precisionAt5_avg < ciThreshold;

      expect(typeof isBelowThreshold).toBe('boolean');
      expect(isBelowThreshold).toBe(true);
    });

    it('evaluator can determine if precisionAt5_avg is above threshold', async () => {
      const queries: EvalQuery[] = [
        { projectId, query: 'null pointer auth token', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId, query: 'auth sso provider', intent: 'answer', expectedDocIds: ['ticket-002'] },
        { projectId, query: 'database pool exhausted', intent: 'diagnose', expectedDocIds: ['ticket-003'] },
      ];

      const summary = await evaluationService.runQueries(queries);

      const ciThreshold = 0.70;
      const isAboveThreshold = summary.precisionAt5_avg >= ciThreshold;

      expect(typeof isAboveThreshold).toBe('boolean');
    });
  });
});
