/**
 * LexicalIndex BM25 Tests
 *
 * RED PHASE: These tests define the contract for an in-memory BM25 lexical index.
 * LexicalIndex does not exist yet — tests will fail to import.
 * Once src/rag/lexical-index.ts is implemented with proper BM25 scoring (k1=1.5, b=0.75),
 * these tests should pass.
 *
 * Acceptance Criteria:
 * AC-14: LexicalIndex.buildIndex(projectId, docs) builds a BM25 index for all documents
 * AC-15: LexicalIndex.search(projectId, query, limit) returns up to limit doc IDs with BM25 scores
 * AC-16: BM25 score uses k1=1.5 and b=0.75
 * AC-17: addDocument() makes doc immediately searchable
 * AC-18: removeDocument() removes doc from results
 * AC-19: search() lazily builds index when warmup not completed
 * AC-22: buildIndex for 10k docs completes in < 5s
 * AC-23: search() on 10k docs returns in < 100ms after warmup
 * AC-24: document_indexed outbox event triggers rebuild
 * AC-25: rebuilds for same project are serialized
 * AC-26: index is project-scoped
 * AC-27: graphify_import does NOT trigger LexicalIndex.buildIndex()
 */

interface Bm25Document {
  id: string;
  content: string;
}

let LexicalIndex: any;
try {
  LexicalIndex = require('../../../src/rag/lexical-index').LexicalIndex;
} catch {
  LexicalIndex = undefined;
}

describe('LexicalIndex — BM25 Core', () => {
  describe('BM25 score parameters', () => {
    it('AC-16: BM25 uses k1=1.5 and b=0.75', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      expect(index['k1']).toBe(1.5);
      expect(index['b']).toBe(0.75);
    });
  });

  describe('BM25 scoring with known corpus', () => {
    const docs: Bm25Document[] = [
      { id: 'doc1', content: 'Authentication failure in login service' },
      { id: 'doc2', content: 'Database connection timeout in postgres' },
      { id: 'doc3', content: 'Authentication token expired, please re-login' },
      { id: 'doc4', content: 'API rate limit exceeded' },
      { id: 'doc5', content: 'Cache miss in redis cache layer' },
    ];

    it('AC-14: buildIndex(projectId, docs) builds a BM25 index for all documents', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', docs);
      expect(index.getIndexSize('test-project')).toBe(docs.length);
    });

    it('AC-15: search(projectId, query, limit) returns up to limit doc IDs with BM25 scores', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', docs);
      const results = index.search('test-project', 'authentication failure', 3);
      expect(results).toHaveLength(3);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('score');
      expect(typeof results[0].score).toBe('number');
    });

    it('scores documents with more query term matches higher', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', docs);
      const results = index.search('test-project', 'authentication', 5);
      const ids = results.map((r: { id: string }) => r.id);
      expect(ids).toContain('doc1');
      expect(ids).toContain('doc3');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('returns zero score for no-matching documents', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', docs);
      const results = index.search('test-project', 'nonexistent query terms xyz', 5);
      expect(results.every((r: { score: number }) => r.score === 0)).toBe(true);
    });

    it('handles case-insensitive matching', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', docs);
      const results = new LexicalIndex().search('test-project', 'AUTHENTICATION', 5);
      expect(results.some((r: { score: number }) => r.score > 0)).toBe(true);
    });
  });

  describe('AC-17: addDocument() immediately searchable', () => {
    it('adds document and it appears in next search', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', [
        { id: 'doc1', content: 'initial content' },
      ]);
      index.addDocument('test-project', { id: 'doc2', content: 'new searchable document' });
      const results = index.search('test-project', 'new searchable', 5);
      expect(results.some((r: { id: string }) => r.id === 'doc2')).toBe(true);
    });
  });

  describe('AC-18: removeDocument() removes from results', () => {
    it('removes document and it no longer appears in search', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      index.buildIndex('test-project', [
        { id: 'doc1', content: 'keep this content' },
        { id: 'doc2', content: 'remove this content' },
      ]);
      index.removeDocument('test-project', 'doc2');
      const results = index.search('test-project', 'remove', 5);
      expect(results.every((r: { id: string }) => r.id !== 'doc2')).toBe(true);
    });
  });

  describe('AC-19: lazy build on first search', () => {
    it('search() builds index on first call when warmup not completed', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const docs = Array.from({ length: 100 }, (_, i) => ({
        id: `doc${i}`,
        content: `content document ${i}`,
      }));
      index.buildIndex('test-project', docs);
      index.setWarmupCompleted('test-project', false);
      const buildSpy = jest.spyOn(index, 'buildIndex' as any);
      index.search('test-project', 'document', 10);
      expect(buildSpy).toHaveBeenCalled();
    });

    it('search() does not rebuild when warmup already completed', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const docs = [{ id: 'doc1', content: 'test content' }];
      index.buildIndex('test-project', docs);
      index.setWarmupCompleted('test-project', true);
      const buildSpy = jest.spyOn(index, 'buildIndex' as any);
      index.search('test-project', 'test', 10);
      expect(buildSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC-22: buildIndex performance for 10k documents', () => {
    it('builds index for 10,000 documents in under 5 seconds', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const docs = Array.from({ length: 10_000 }, (_, i) => ({
        id: `doc${i}`,
        content: `document content for testing bm25 performance ${i} ${i * 2}`,
      }));
      const start = Date.now();
      index.buildIndex('test-project', docs);
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('AC-23: search performance after warmup', () => {
    it('search() returns in under 100ms for 10k docs after warmup', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const docs = Array.from({ length: 10_000 }, (_, i) => ({
        id: `doc${i}`,
        content: `document content for testing bm25 search performance ${i}`,
      }));
      index.buildIndex('test-project', docs);
      index.setWarmupCompleted('test-project', true);
      const start = Date.now();
      const results = index.search('test-project', 'testing document performance', 20);
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100);
      expect(results).toHaveLength(20);
    });
  });
});

describe('LexicalIndex — Outbox Event Integration', () => {
  let index: any;

  beforeEach(() => {
    expect(LexicalIndex).toBeDefined();
    index = new LexicalIndex();
  });

  describe('AC-24: document_indexed event triggers rebuild', () => {
    it('receiving document_indexed event calls buildIndex for project', async () => {
      const docs = [
        { id: 'doc1', content: 'original content' },
        { id: 'doc2', content: 'updated content' },
      ];
      index.buildIndex('test-project', docs);
      const buildSpy = jest.spyOn(index, 'buildIndex');
      const event = {
        eventType: 'document_indexed',
        payload: { projectId: 'test-project', sourceId: 'doc1', content: 'new content', metadata: {} },
      };
      await index.handleOutboxEvent(event);
      expect(buildSpy).toHaveBeenCalledWith('test-project', expect.any(Array));
    });
  });

  describe('AC-25: rebuilds serialized per project', () => {
    it('concurrent rebuilds for same project do not corrupt index', async () => {
      const docs = Array.from({ length: 100 }, (_, i) => ({
        id: `doc${i}`,
        content: `content ${i}`,
      }));
      index.buildIndex('test-project', docs);
      const events = Array.from({ length: 5 }, (_, i) => ({
        eventType: 'document_indexed',
        payload: { projectId: 'test-project', sourceId: `doc${i}`, content: `new content ${i}`, metadata: {} },
      }));
      await Promise.all(events.map((e) => index.handleOutboxEvent(e)));
      const searchResults = index.search('test-project', 'new content', 10);
      expect(searchResults.length).toBeGreaterThan(0);
    });

    it('rebuilds for different projects run concurrently', async () => {
      const docsA = [{ id: 'a1', content: 'project a content' }];
      const docsB = [{ id: 'b1', content: 'project b content' }];
      index.buildIndex('project-a', docsA);
      index.buildIndex('project-b', docsB);
      const results = await Promise.all([
        index.handleOutboxEvent({ eventType: 'document_indexed', payload: { projectId: 'project-a', sourceId: 'a1', content: 'a new', metadata: {} } }),
        index.handleOutboxEvent({ eventType: 'document_indexed', payload: { projectId: 'project-b', sourceId: 'b1', content: 'b new', metadata: {} } }),
      ]);
      expect(results[0]).toBeDefined();
      expect(results[1]).toBeDefined();
    });
  });

  describe('AC-27: graphify_import does NOT trigger BM25 rebuild', () => {
    it('graphify_import event does not call LexicalIndex.buildIndex', async () => {
      const docs = [{ id: 'doc1', content: 'original' }];
      index.buildIndex('test-project', docs);
      const buildSpy = jest.spyOn(index, 'buildIndex');
      const event = {
        eventType: 'graphify_import',
        payload: { projectId: 'test-project', nodeCount: 10, linkCount: 5 },
      };
      await index.handleOutboxEvent(event);
      expect(buildSpy).not.toHaveBeenCalled();
    });
  });
});

describe('LexicalIndex — Project Scoping', () => {
  let index: any;

  beforeEach(() => {
    expect(LexicalIndex).toBeDefined();
    index = new LexicalIndex();
  });

  describe('AC-26: project-scoped index isolation', () => {
    it('indexes are separate per project', () => {
      const docsA = [{ id: 'a1', content: 'alpha project document' }];
      const docsB = [{ id: 'b1', content: 'beta project document' }];
      index.buildIndex('project-a', docsA);
      index.buildIndex('project-b', docsB);
      const resultsA = index.search('project-a', 'alpha', 10);
      const resultsB = index.search('project-b', 'beta', 10);
      expect(resultsA.every((r: { id: string }) => r.id === 'a1')).toBe(true);
      expect(resultsB.every((r: { id: string }) => r.id === 'b1')).toBe(true);
    });

    it('searching one project does not affect another', () => {
      const docsA = [{ id: 'a1', content: 'unique content for a' }];
      const docsB = [{ id: 'b1', content: 'unique content for b' }];
      index.buildIndex('project-a', docsA);
      index.buildIndex('project-b', docsB);
      index.search('project-a', 'unique', 10);
      const resultsB = index.search('project-b', 'unique', 10);
      expect(resultsB).toHaveLength(1);
      expect(resultsB[0].id).toBe('b1');
    });

    it('addDocument to one project does not affect other project index', () => {
      const docsA = [{ id: 'a1', content: 'a only content' }];
      const docsB = [{ id: 'b1', content: 'b only content' }];
      index.buildIndex('project-a', docsA);
      index.buildIndex('project-b', docsB);
      index.addDocument('project-a', { id: 'a2', content: 'new a content' });
      const resultsB = index.search('project-b', 'new', 10);
      expect(resultsB).toHaveLength(0);
    });
  });
});

describe('LexicalIndex — API Startup Warmup', () => {
  describe('AC-20: startup warmup for active projects', () => {
    it('warmup job can run while API accepts traffic', async () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const docs = Array.from({ length: 1000 }, (_, i) => ({
        id: `doc${i}`,
        content: `warmup content ${i}`,
      }));
      index.buildIndex('active-project', docs);
      index.setWarmupCompleted('active-project', false);
      const warmupPromise = index.warmup(['active-project']);
      const searchResult = index.search('active-project', 'warmup', 5);
      expect(searchResult).toBeDefined();
      await warmupPromise;
      expect(index.isWarmupCompleted('active-project')).toBe(true);
    });

    it('warmup starts for projects with at least one document', () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const activeProjects = ['project-with-docs', 'empty-project'];
      index.buildIndex('project-with-docs', [{ id: 'doc1', content: 'has content' }]);
      index.buildIndex('empty-project', []);
      const warmupProjects = index.getProjectsNeedingWarmup(activeProjects);
      expect(warmupProjects).toContain('project-with-docs');
      expect(warmupProjects).not.toContain('empty-project');
    });
  });
});

describe('LexicalIndex — Cold Start Latency', () => {
  describe('AC-21: first search may take 2x latency but completes', () => {
    it('first search completes even with lazy build cost', async () => {
      expect(LexicalIndex).toBeDefined();
      const index = new LexicalIndex();
      const docs = Array.from({ length: 5000 }, (_, i) => ({
        id: `doc${i}`,
        content: `cold start document ${i}`,
      }));
      index.buildIndex('cold-project', docs);
      index.setWarmupCompleted('cold-project', false);
      const start = Date.now();
      const results = await index.search('cold-project', 'cold start document', 20);
      const duration = Date.now() - start;
      expect(results).toHaveLength(20);
      expect(duration).toBeLessThan(10000);
    });
  });
});
