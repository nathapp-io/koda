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
    throw new Error('EvaluationService.runQueries not yet implemented');
  }
}
