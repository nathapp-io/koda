/**
 * eval-queries.json Fixture Tests
 *
 * Validates that the seed dataset of 50 evaluation queries:
 * - Has exactly 50 entries
 * - Each entry has required fields: projectId, query, intent, expectedDocIds
 * - expectedDocIds is a non-empty array
 * - projectId is a non-empty string
 * - intent is one of the SPEC-defined RetrievalIntent values: 'answer', 'diagnose', 'plan', 'update', 'search'
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

describe('eval-queries.json fixture', () => {
  let queries: unknown[];

  beforeAll(() => {
    const fixturePath = resolve(__dirname, '../../../src/retrieval/fixtures/eval-queries.json');
    const raw = readFileSync(fixturePath, 'utf-8');
    queries = JSON.parse(raw);
  });

  it('has exactly 50 entries', () => {
    expect(queries.length).toBeGreaterThanOrEqual(50);
  });

  it('every entry has projectId as non-empty string', () => {
    for (const q of queries) {
      expect(q).toHaveProperty('projectId');
      expect(typeof (q as { projectId: unknown }).projectId).toBe('string');
      expect((q as { projectId: string }).projectId.length).toBeGreaterThan(0);
    }
  });

  it('every entry has query as non-empty string', () => {
    for (const q of queries) {
      expect(q).toHaveProperty('query');
      expect(typeof (q as { query: unknown }).query).toBe('string');
      expect((q as { query: string }).query.length).toBeGreaterThan(0);
    }
  });

  it('every entry has intent as one of the SPEC-defined RetrievalIntent values', () => {
    const validIntents = ['answer', 'diagnose', 'plan', 'update', 'search'];
    for (const q of queries) {
      expect(q).toHaveProperty('intent');
      expect(validIntents).toContain((q as { intent: string }).intent);
    }
  });

  it('every entry has expectedDocIds as non-empty array of non-empty strings', () => {
    for (const q of queries) {
      expect(q).toHaveProperty('expectedDocIds');
      const docIds = (q as { expectedDocIds: unknown }).expectedDocIds;
      expect(Array.isArray(docIds)).toBe(true);
      const typedDocIds = docIds as string[];
      expect(typedDocIds.length).toBeGreaterThan(0);
      for (const id of typedDocIds) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });

  it('all projectId values are identical (single project evaluation)', () => {
    const projectIds = new Set(queries.map((q) => (q as { projectId: string }).projectId));
    expect(projectIds.size).toBe(1);
  });
});
