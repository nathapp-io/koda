import { Injectable } from '@nestjs/common';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';

export interface EvalQuery {
  projectId: string;
  query: string;
  intent: string;
  expectedDocIds: string[];
}

export interface SingleQueryResult {
  query: string;
  intent: string;
  expectedDocIds: string[];
  actualDocIds: string[];
  precisionAt5: number;
  retrievedAt: string;
}

export interface EvalSummary {
  precisionAt5_avg: number;
  precisionAt5_p50: number;
  precisionAt5_p95: number;
  totalQueries: number;
  results: SingleQueryResult[];
}

@Injectable()
export class EvaluationService {
  constructor(private readonly hybridRetriever: HybridRetrieverService) {}

  async runQueries(queries: EvalQuery[]): Promise<EvalSummary> {
    const results: SingleQueryResult[] = [];

    for (const q of queries) {
      const searchResult = await this.hybridRetriever.search({
        projectId: q.projectId,
        query: q.query,
        intent: q.intent,
        limit: 5,
      });

      const top5 = searchResult.results.slice(0, 5);
      const actualDocIds = top5.map((r) => r.sourceId);
      const expectedSet = new Set(q.expectedDocIds);
      const matches = top5.filter((r) => expectedSet.has(r.sourceId)).length;
      // Standard precision@5: hits in top-5 divided by 5
      const precisionAt5 = top5.length > 0 ? matches / 5 : 0;

      results.push({
        query: q.query,
        intent: q.intent,
        expectedDocIds: q.expectedDocIds,
        actualDocIds,
        precisionAt5,
        retrievedAt: searchResult.retrievedAt,
      });
    }

    const precisionValues = results.map((r) => r.precisionAt5);
    return {
      results,
      totalQueries: queries.length,
      precisionAt5_avg: this.mean(precisionValues),
      precisionAt5_p50: this.percentile(precisionValues, 50),
      precisionAt5_p95: this.percentile(precisionValues, 95),
    };
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
  }
}
