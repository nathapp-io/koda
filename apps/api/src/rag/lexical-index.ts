/**
 * LexicalIndex — In-Memory BM25 Index
 *
 * RED PHASE: This stub exists so test imports compile.
 * Real BM25 implementation is pending.
 *
 * ACs covered:
 * - buildIndex(projectId, docs) — builds BM25 index
 * - search(projectId, query, limit) — returns doc IDs with BM25 scores
 * - k1=1.5, b=0.75 BM25 parameters
 * - addDocument(projectId, doc) — incremental add
 * - removeDocument(projectId, docId) — incremental remove
 * - lazy build on first search
 * - startup warmup
 * - outbox event handler
 * - project-scoped isolation
 */
export interface Bm25Document {
  id: string;
  content: string;
}

export interface Bm25SearchResult {
  id: string;
  score: number;
}

export class LexicalIndex {
  readonly k1 = 1.5;
  readonly b = 0.75;

  buildIndex(projectId: string, docs: Bm25Document[]): void {
    throw new Error('LexicalIndex.buildIndex not yet implemented');
  }

  search(projectId: string, query: string, limit = 20): Bm25SearchResult[] {
    throw new Error('LexicalIndex.search not yet implemented');
  }

  addDocument(projectId: string, doc: Bm25Document): void {
    throw new Error('LexicalIndex.addDocument not yet implemented');
  }

  removeDocument(projectId: string, docId: string): void {
    throw new Error('LexicalIndex.removeDocument not yet implemented');
  }

  getIndexSize(projectId: string): number {
    throw new Error('LexicalIndex.getIndexSize not yet implemented');
  }

  setWarmupCompleted(projectId: string, completed: boolean): void {
    throw new Error('LexicalIndex.setWarmupCompleted not yet implemented');
  }

  isWarmupCompleted(projectId: string): boolean {
    throw new Error('LexicalIndex.isWarmupCompleted not yet implemented');
  }

  warmup(projectIds: string[]): Promise<void> {
    throw new Error('LexicalIndex.warmup not yet implemented');
  }

  getProjectsNeedingWarmup(projectIds: string[]): string[] {
    throw new Error('LexicalIndex.getProjectsNeedingWarmup not yet implemented');
  }

  handleOutboxEvent(event: { eventType: string; payload: unknown }): Promise<void> {
    throw new Error('LexicalIndex.handleOutboxEvent not yet implemented');
  }
}
