/**
 * LexicalIndex — In-Memory BM25 Index
 *
 * Implements project-scoped BM25 lexical search with:
 * - k1=1.5, b=0.75 BM25 parameters
 * - Lazy project builds on first search
 * - Incremental add/remove behavior
 * - Startup warmup for active projects
 * - Serialized rebuilds from document_indexed outbox events
 * - Project-scoped isolation
 */
export interface Bm25Document {
  id: string;
  content: string;
}

export interface Bm25SearchResult {
  id: string;
  score: number;
}

interface IndexedDocument {
  id: string;
  content: string;
  terms: Map<string, number>;
  docLength: number;
}

interface ProjectIndex {
  docs: Map<string, IndexedDocument>;
  termDocFreq: Map<string, Set<string>>;
  avgDocLength: number;
  warmupCompleted: boolean;
  rebuildLock: boolean;
}

export class LexicalIndex {
  readonly k1 = 1.5;
  readonly b = 0.75;
  private readonly maxIndexes = 1_000;

  private indexes = new Map<string, ProjectIndex>();
  private lastAccessed = new Map<string, number>();

  buildIndex(projectId: string, docs: Bm25Document[]): void {
    const projectIndex = this.getOrCreateProjectIndex(projectId);
    projectIndex.docs.clear();
    projectIndex.termDocFreq.clear();

    for (const doc of docs) {
      const indexedDoc = this.indexDocument(doc);
      projectIndex.docs.set(doc.id, indexedDoc);
      for (const term of indexedDoc.terms.keys()) {
        if (!projectIndex.termDocFreq.has(term)) {
          projectIndex.termDocFreq.set(term, new Set());
        }
        projectIndex.termDocFreq.get(term)?.add(doc.id);
      }
    }

    projectIndex.avgDocLength = docs.length > 0
      ? Array.from(projectIndex.docs.values()).reduce((sum, d) => sum + d.docLength, 0) / docs.length
      : 0;
  }

  search(projectId: string, query: string, limit = 20): Bm25SearchResult[] {
    const projectIndex = this.indexes.get(projectId);

    if (!projectIndex || projectIndex.docs.size === 0) {
      return [];
    }
    this.touchProject(projectId);

    if (!projectIndex.warmupCompleted && projectIndex.docs.size > 0) {
      if (projectIndex.rebuildLock) {
        return [];
      }
      projectIndex.rebuildLock = true;
      try {
        const docs = Array.from(projectIndex.docs.values()).map(d => ({
          id: d.id,
          content: d.content,
        }));
        this.buildIndex(projectId, docs);
      } finally {
        projectIndex.rebuildLock = false;
      }
    }

    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return [];
    }

    const scores = new Map<string, number>();
    const docCount = projectIndex.docs.size;
    const avgDL = projectIndex.avgDocLength || 1;

    for (const [docId, doc] of projectIndex.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.terms.get(term) || 0;
        if (tf > 0) {
          const df = projectIndex.termDocFreq.get(term)?.size || 0;
          if (df > 0) {
            const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
            const numerator = tf * (this.k1 + 1);
            const denominator = tf + this.k1 * (1 - this.b + this.b * doc.docLength / avgDL);
            score += idf * numerator / denominator;
          }
        }
      }
      if (score > 0) {
        scores.set(docId, score);
      }
    }

    const sortedResults = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ id, score }));

    return sortedResults;
  }

  addDocument(projectId: string, doc: Bm25Document): void {
    const projectIndex = this.getOrCreateProjectIndex(projectId);
    const indexedDoc = this.indexDocument(doc);
    projectIndex.docs.set(doc.id, indexedDoc);

    for (const term of indexedDoc.terms.keys()) {
      if (!projectIndex.termDocFreq.has(term)) {
        projectIndex.termDocFreq.set(term, new Set());
      }
      projectIndex.termDocFreq.get(term)?.add(doc.id);
    }

    const docLengths = Array.from(projectIndex.docs.values()).map(d => d.docLength);
    projectIndex.avgDocLength = docLengths.reduce((a, b) => a + b, 0) / docLengths.length;
  }

  removeDocument(projectId: string, docId: string): void {
    const projectIndex = this.indexes.get(projectId);
    if (!projectIndex) return;
    this.touchProject(projectId);

    const doc = projectIndex.docs.get(docId);
    if (!doc) return;

    for (const term of doc.terms.keys()) {
      const docSet = projectIndex.termDocFreq.get(term);
      if (docSet) {
        docSet.delete(docId);
        if (docSet.size === 0) {
          projectIndex.termDocFreq.delete(term);
        }
      }
    }

    projectIndex.docs.delete(docId);

    if (projectIndex.docs.size > 0) {
      const docLengths = Array.from(projectIndex.docs.values()).map(d => d.docLength);
      projectIndex.avgDocLength = docLengths.reduce((a, b) => a + b, 0) / docLengths.length;
    } else {
      this.clearProject(projectId);
    }
  }

  getIndexSize(projectId: string): number {
    return this.indexes.get(projectId)?.docs.size ?? 0;
  }

  setWarmupCompleted(projectId: string, completed: boolean): void {
    const projectIndex = this.indexes.get(projectId);
    if (projectIndex) {
      this.touchProject(projectId);
      projectIndex.warmupCompleted = completed;
    }
  }

  isWarmupCompleted(projectId: string): boolean {
    return this.indexes.get(projectId)?.warmupCompleted ?? false;
  }

  async warmup(projectIds: string[]): Promise<void> {
    const projectsToWarmup = this.getProjectsNeedingWarmup(projectIds);

    await Promise.all(
      projectsToWarmup.map(async (projectId) => {
        const projectIndex = this.indexes.get(projectId);
        if (projectIndex && projectIndex.docs.size > 0) {
          projectIndex.warmupCompleted = true;
        }
      })
    );
  }

  getProjectsNeedingWarmup(projectIds: string[]): string[] {
    return projectIds.filter((projectId) => {
      const projectIndex = this.indexes.get(projectId);
      return projectIndex && projectIndex.docs.size > 0 && !projectIndex.warmupCompleted;
    });
  }

  async handleOutboxEvent(event: { eventType: string; payload: unknown }): Promise<boolean> {
    if (event.eventType === 'document_indexed') {
      const payload = event.payload as { projectId: string; sourceId?: string; content?: string; metadata?: Record<string, unknown> };

      const projectIndex = this.indexes.get(payload.projectId);
      if (!projectIndex || projectIndex.docs.size === 0) {
        return false;
      }
      this.touchProject(payload.projectId);

      while (projectIndex.rebuildLock) {
        await new Promise(resolve => setImmediate(resolve));
      }

      projectIndex.rebuildLock = true;
      try {
        const docs = Array.from(projectIndex.docs.values()).map(d => ({
          id: d.id,
          content: d.content,
        }));

        if (payload.sourceId && payload.content) {
          const existing = docs.find(d => d.id === payload.sourceId);
          if (existing) {
            existing.content = payload.content;
          }
        }

        this.buildIndex(payload.projectId, docs);
        return true;
      } finally {
        projectIndex.rebuildLock = false;
      }
    }
    return false;
  }

  clearProject(projectId: string): void {
    this.indexes.delete(projectId);
    this.lastAccessed.delete(projectId);
  }

  private getOrCreateProjectIndex(projectId: string): ProjectIndex {
    this.touchProject(projectId);
    let projectIndex = this.indexes.get(projectId);
    if (!projectIndex) {
      this.evictIfNeeded();
      projectIndex = {
        docs: new Map(),
        termDocFreq: new Map(),
        avgDocLength: 0,
        warmupCompleted: false,
        rebuildLock: false,
      };
      this.indexes.set(projectId, projectIndex);
    }
    return projectIndex;
  }

  private touchProject(projectId: string): void {
    this.lastAccessed.set(projectId, Date.now());
  }

  private evictIfNeeded(): void {
    while (this.indexes.size >= this.maxIndexes) {
      let oldestProjectId: string | null = null;
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const [projectId, ts] of this.lastAccessed) {
        if (ts < oldestTs) {
          oldestTs = ts;
          oldestProjectId = projectId;
        }
      }
      if (!oldestProjectId) {
        break;
      }
      this.clearProject(oldestProjectId);
    }
  }

  private indexDocument(doc: Bm25Document): IndexedDocument {
    const terms = this.tokenize(doc.content);
    const termFreq = new Map<string, number>();
    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }
    return {
      id: doc.id,
      content: doc.content,
      terms: termFreq,
      docLength: terms.length,
    };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length > 0);
  }
}
