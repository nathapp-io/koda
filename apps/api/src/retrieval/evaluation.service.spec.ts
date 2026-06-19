import { Test, TestingModule } from '@nestjs/testing';
import { createMock } from '@golevelup/ts-jest';
import { EvaluationService } from './evaluation.service';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';

const makeRetriever = (ids: string[]) =>
  createMock<HybridRetrieverService>({
    search: jest.fn().mockResolvedValue({
      results: ids.map((id) => ({ sourceId: id, score: 0.9, content: '' })),
      retrievedAt: '2026-01-01T00:00:00.000Z',
    }),
  });

describe('EvaluationService', () => {
  let service: EvaluationService;
  let retriever: HybridRetrieverService;

  async function build(ids: string[]) {
    retriever = makeRetriever(ids);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvaluationService,
        { provide: HybridRetrieverService, useValue: retriever },
      ],
    }).compile();
    service = module.get(EvaluationService);
  }

  describe('runQueries', () => {
    it('returns empty summary for zero queries', async () => {
      await build([]);
      const summary = await service.runQueries([]);
      expect(summary.totalQueries).toBe(0);
      expect(summary.precisionAt5_avg).toBe(0);
      expect(summary.precisionAt5_p50).toBe(0);
      expect(summary.precisionAt5_p95).toBe(0);
      expect(summary.results).toHaveLength(0);
    });

    it('calculates precisionAt5 = 1 when all top-5 docs are expected', async () => {
      await build(['d1', 'd2', 'd3', 'd4', 'd5']);
      const summary = await service.runQueries([
        { projectId: 'p1', query: 'q', intent: 'plan', expectedDocIds: ['d1', 'd2', 'd3', 'd4', 'd5'] },
      ]);
      expect(summary.results[0].precisionAt5).toBe(1);
    });

    it('calculates precisionAt5 = 0 when no top-5 docs are expected', async () => {
      await build(['x1', 'x2', 'x3', 'x4', 'x5']);
      const summary = await service.runQueries([
        { projectId: 'p1', query: 'q', intent: 'plan', expectedDocIds: ['d1', 'd2'] },
      ]);
      expect(summary.results[0].precisionAt5).toBe(0);
    });

    it('normalises by expected set size when smaller than k=5', async () => {
      await build(['d1', 'd2', 'x3', 'x4', 'x5']);
      const summary = await service.runQueries([
        { projectId: 'p1', query: 'q', intent: 'plan', expectedDocIds: ['d1', 'd2'] },
      ]);
      expect(summary.results[0].precisionAt5).toBe(1);
    });

    it('calculates correct avg, p50, p95 for multiple queries', async () => {
      const retrieverMock = createMock<HybridRetrieverService>();
      (retrieverMock.search as unknown as jest.Mock)
        .mockResolvedValueOnce({
          results: ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => ({ sourceId: id, score: 0.9, content: '' })),
          retrievedAt: '2026-01-01T00:00:00.000Z',
        })
        .mockResolvedValueOnce({
          results: ['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => ({ sourceId: id, score: 0.9, content: '' })),
          retrievedAt: '2026-01-01T00:00:00.000Z',
        });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EvaluationService,
          { provide: HybridRetrieverService, useValue: retrieverMock },
        ],
      }).compile();
      const svc = module.get(EvaluationService);

      const summary = await svc.runQueries([
        { projectId: 'p1', query: 'q1', intent: 'plan', expectedDocIds: ['d1', 'd2', 'd3', 'd4', 'd5'] },
        { projectId: 'p1', query: 'q2', intent: 'plan', expectedDocIds: ['d1'] },
      ]);

      expect(summary.totalQueries).toBe(2);
      expect(summary.precisionAt5_avg).toBe(0.5);
      expect(summary.precisionAt5_p50).toBe(0.5);
      expect(summary.precisionAt5_p95).toBeCloseTo(0.95);
    });

    it('handles expectedDocIds being empty (edge case)', async () => {
      await build(['d1', 'd2', 'd3', 'd4', 'd5']);
      const summary = await service.runQueries([
        { projectId: 'p1', query: 'q', intent: 'plan', expectedDocIds: [] },
      ]);
      expect(summary.results[0].precisionAt5).toBe(0);
    });

    it('passes correct search parameters to retriever', async () => {
      await build([]);
      await service.runQueries([
        { projectId: 'proj-1', query: 'find bug', intent: 'diagnose', expectedDocIds: [] },
      ]);
      expect(retriever.search).toHaveBeenCalledWith({
        projectId: 'proj-1',
        query: 'find bug',
        intent: 'diagnose',
        limit: 5,
      });
    });
  });
});
