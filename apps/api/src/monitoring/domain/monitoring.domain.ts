export const MONITORING_REPOSITORY = Symbol('MONITORING_REPOSITORY');

export interface MemoryQueryMetricDomain {
  id: string;
  projectId: string;
  intent: string;
  latencyMs: number;
  tokensUsed: number | null;
  hadProvenance: boolean;
  staleHitCount: number;
  resultCount: number;
  leakageIncidentCount: number;
  docId?: string | null;
  createdAt: Date;
}
