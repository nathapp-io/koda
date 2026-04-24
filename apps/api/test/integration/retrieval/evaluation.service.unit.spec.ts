/**
 * EvaluationService Unit Tests
 *
 * RED PHASE: These tests fail because EvaluationService.runQueries is not yet implemented.
 *
 * Acceptance Criteria:
 * AC1: runQueries(queries) runs each query through HybridRetrieverService and returns precision@5 per query
 * AC2: runQueries returns summary with precisionAt5_avg, precisionAt5_p50, precisionAt5_p95, totalQueries
 * AC3: Each SingleQueryResult includes query, intent, expectedDocIds, actualDocIds, precisionAt5, retrievedAt
 * AC4: precisionAt5 = count of expectedDocIds found in top 5 results / total expectedDocIds
 * AC5: p50 is the 50th percentile (median) of precisionAt5 values across all queries
 * AC6: p95 is the 95th percentile of precisionAt5 values across all queries
 * AC7: totalQueries equals the number of input queries
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EvaluationService, EvalQuery, SingleQueryResult } from '../../../src/retrieval/evaluation.service';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';

jest.setTimeout(30000);

const fakeResultDoc = (sourceId: string) => ({
  id: `id_${sourceId}`,
  source: 'ticket' as const,
  sourceId,
  content: 'fake content',
  score: 0.9,
  similarity: 'high' as const,
  metadata: {},
  createdAt: new Date().toISOString(),
  provenance: {
    indexedAt: new Date().toISOString(),
    sourceProjectId: 'proj_eval_001',
  },
  rank: 1,
});

describe('EvaluationService unit', () => {
  let module: TestingModule;
  let evaluationService: EvaluationService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockHybridRetriever: any;

  beforeEach(async () => {
    mockHybridRetriever = {
      search: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        EvaluationService,
        {
          provide: HybridRetrieverService,
          useValue: mockHybridRetriever,
        },
      ],
    }).compile();

    evaluationService = module.get<EvaluationService>(EvaluationService);
  });

  afterEach(async () => {
    if (module) await module.close();
  });

  describe('AC1 & AC3: runQueries calls HybridRetrieverService and returns per-query results', () => {
    it('calls hybridRetriever.search once per query', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth token error',
          intent: 'answer',
          expectedDocIds: ['ticket-001', 'ticket-002'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [fakeResultDoc('ticket-001'), fakeResultDoc('ticket-002')],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      await evaluationService.runQueries(queries);

      expect(mockHybridRetriever.search).toHaveBeenCalledTimes(1);
      expect(mockHybridRetriever.search).toHaveBeenCalledWith({
        projectId: 'proj_eval_001',
        query: 'auth token error',
        intent: 'answer',
        limit: 5,
      });
    });

    it('returns SingleQueryResult with all required fields per query', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'null pointer',
          intent: 'reproduce',
          expectedDocIds: ['ticket-001'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [fakeResultDoc('ticket-001')],
        scores: [],
        retrievedAt: '2026-01-01T00:00:00.000Z',
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results).toHaveLength(1);
      const result = summary.results[0];
      expect(result).toHaveProperty('query', 'null pointer');
      expect(result).toHaveProperty('intent', 'reproduce');
      expect(result).toHaveProperty('expectedDocIds', ['ticket-001']);
      expect(result).toHaveProperty('actualDocIds');
      expect(result).toHaveProperty('precisionAt5');
      expect(result).toHaveProperty('retrievedAt', '2026-01-01T00:00:00.000Z');
    });

    it('returns empty actualDocIds and precisionAt5=0 when no results returned', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'nonexistent issue',
          intent: 'answer',
          expectedDocIds: ['ticket-999'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].actualDocIds).toEqual([]);
      expect(summary.results[0].precisionAt5).toBe(0);
    });
  });

  describe('AC4: precisionAt5 calculation', () => {
    it('precisionAt5 = 1.0 when all expected docs are in top 5 results', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth issue',
          intent: 'answer',
          expectedDocIds: ['ticket-001', 'ticket-002'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [
          fakeResultDoc('ticket-001'),
          fakeResultDoc('ticket-002'),
          fakeResultDoc('ticket-003'),
          fakeResultDoc('ticket-004'),
          fakeResultDoc('ticket-005'),
        ],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(1.0);
    });

    it('precisionAt5 = 0.0 when no expected docs are in top 5 results', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth issue',
          intent: 'answer',
          expectedDocIds: ['ticket-999', 'ticket-998'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [
          fakeResultDoc('ticket-001'),
          fakeResultDoc('ticket-002'),
          fakeResultDoc('ticket-003'),
          fakeResultDoc('ticket-004'),
          fakeResultDoc('ticket-005'),
        ],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(0.0);
    });

    it('precisionAt5 = 0.5 when half of expected docs are in top 5 results', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth issue',
          intent: 'answer',
          expectedDocIds: ['ticket-001', 'ticket-999'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [
          fakeResultDoc('ticket-001'),
          fakeResultDoc('ticket-002'),
          fakeResultDoc('ticket-003'),
          fakeResultDoc('ticket-004'),
          fakeResultDoc('ticket-005'),
        ],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(0.5);
    });

    it('handles more than 5 expected docs (all 6 in top 5 -> precision@5 capped at 1.0)', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth issue',
          intent: 'answer',
          expectedDocIds: ['ticket-001', 'ticket-002', 'ticket-003', 'ticket-004', 'ticket-005', 'ticket-006'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [
          fakeResultDoc('ticket-001'),
          fakeResultDoc('ticket-002'),
          fakeResultDoc('ticket-003'),
          fakeResultDoc('ticket-004'),
          fakeResultDoc('ticket-005'),
        ],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(1.0);
    });

    it('uses top 5 results only for precision calculation regardless of limit', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth issue',
          intent: 'answer',
          expectedDocIds: ['ticket-003'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [
          fakeResultDoc('ticket-001'),
          fakeResultDoc('ticket-002'),
          fakeResultDoc('ticket-003'),
          fakeResultDoc('ticket-004'),
          fakeResultDoc('ticket-005'),
        ],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(1.0);
    });
  });

  describe('AC2 & AC7: summary fields', () => {
    it('totalQueries equals number of input queries', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['a'] },
        { projectId: 'proj_eval_001', query: 'q2', intent: 'reproduce', expectedDocIds: ['b'] },
        { projectId: 'proj_eval_001', query: 'q3', intent: 'review', expectedDocIds: ['c'] },
      ];

      for (const q of queries) {
        mockHybridRetriever.search.mockResolvedValue({
          results: [],
          scores: [],
          retrievedAt: new Date().toISOString(),
        });
      }

      const summary = await evaluationService.runQueries(queries);

      expect(summary.totalQueries).toBe(3);
    });

    it('summary contains precisionAt5_avg field', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [fakeResultDoc('ticket-001')],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary).toHaveProperty('precisionAt5_avg');
      expect(typeof summary.precisionAt5_avg).toBe('number');
    });

    it('summary contains precisionAt5_p50 field', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [fakeResultDoc('ticket-001')],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary).toHaveProperty('precisionAt5_p50');
      expect(typeof summary.precisionAt5_p50).toBe('number');
    });

    it('summary contains precisionAt5_p95 field', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [fakeResultDoc('ticket-001')],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary).toHaveProperty('precisionAt5_p95');
      expect(typeof summary.precisionAt5_p95).toBe('number');
    });
  });

  describe('AC5 & AC6: percentile calculations', () => {
    it('precisionAt5_avg is mean of all precisionAt5 values', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId: 'proj_eval_001', query: 'q2', intent: 'answer', expectedDocIds: ['ticket-002'] },
      ];

      mockHybridRetriever.search
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-001')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [],
          scores: [],
          retrievedAt: new Date().toISOString(),
        });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_avg).toBe(0.5);
    });

    it('precisionAt5_p50 is median of all precisionAt5 values', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId: 'proj_eval_001', query: 'q2', intent: 'answer', expectedDocIds: ['ticket-002'] },
        { projectId: 'proj_eval_001', query: 'q3', intent: 'answer', expectedDocIds: ['ticket-003'] },
      ];

      mockHybridRetriever.search
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-001')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-003')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_p50).toBe(1.0);
    });

    it('precisionAt5_p95 is 95th percentile of all precisionAt5 values', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId: 'proj_eval_001', query: 'q2', intent: 'answer', expectedDocIds: ['ticket-002'] },
        { projectId: 'proj_eval_001', query: 'q3', intent: 'answer', expectedDocIds: ['ticket-003'] },
        { projectId: 'proj_eval_001', query: 'q4', intent: 'answer', expectedDocIds: ['ticket-004'] },
      ];

      mockHybridRetriever.search
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-001')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-002')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-003')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [],
          scores: [],
          retrievedAt: new Date().toISOString(),
        });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_p95).toBe(1.0);
    });

    it('p95 equals max when all values are identical', async () => {
      const queries: EvalQuery[] = [
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: ['ticket-001'] },
        { projectId: 'proj_eval_001', query: 'q2', intent: 'answer', expectedDocIds: ['ticket-002'] },
      ];

      mockHybridRetriever.search
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-001')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          results: [fakeResultDoc('ticket-002')],
          scores: [],
          retrievedAt: new Date().toISOString(),
        });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.precisionAt5_p95).toBe(1.0);
    });
  });

  describe('edge cases', () => {
    it('works with empty query list (totalQueries=0, avg=0)', async () => {
      const queries: EvalQuery[] = [];

      const summary = await evaluationService.runQueries(queries);

      expect(summary.totalQueries).toBe(0);
      expect(summary.precisionAt5_avg).toBe(0);
      expect(summary.precisionAt5_p50).toBe(0);
      expect(summary.precisionAt5_p95).toBe(0);
      expect(summary.results).toHaveLength(0);
    });

    it('handles undefined expectedDocIds as empty array', async () => {
      const queries: EvalQuery[] = [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { projectId: 'proj_eval_001', query: 'q1', intent: 'answer', expectedDocIds: [] as any as string[] },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [fakeResultDoc('ticket-001')],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].precisionAt5).toBe(0);
    });

    it('maps actualDocIds correctly from hybrid search results', async () => {
      const queries: EvalQuery[] = [
        {
          projectId: 'proj_eval_001',
          query: 'auth issue',
          intent: 'answer',
          expectedDocIds: ['ticket-001'],
        },
      ];

      mockHybridRetriever.search.mockResolvedValue({
        results: [
          fakeResultDoc('ticket-001'),
          fakeResultDoc('ticket-002'),
          fakeResultDoc('ticket-003'),
        ],
        scores: [],
        retrievedAt: new Date().toISOString(),
      });

      const summary = await evaluationService.runQueries(queries);

      expect(summary.results[0].actualDocIds).toEqual(['ticket-001', 'ticket-002', 'ticket-003']);
    });
  });
});
