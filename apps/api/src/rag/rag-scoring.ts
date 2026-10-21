/**
 * The RAG scoring primitives: in-memory FTS scoring, reciprocal-rank fusion and the similarity/verdict tiers.
 *
 * These live in their own leaf module (no imports at all) because both `rag.service.ts` and
 * `vector-store.service.ts` need them. They used to live on `rag.service`, which turned those two files into a
 * runtime import cycle: whichever one was loaded first left `RagService`'s `design:paramtypes[0]` as `Object`
 * instead of the `VectorStore` class under the DB suite's shared module cache, and `Test.createTestingModule`
 * failed intermittently with `Nest can't resolve dependencies of the RagService (?, …)`.
 * `src/rag/rag-module-import-cycle.spec.ts` pins the split.
 */

/**
 * In-memory FTS for MVP. Replace with LanceDB native FTS (Tantivy) when corpus exceeds 500 documents.
 */
export function simpleFtsScore(content: string, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return 0;

  const lower = content.toLowerCase();
  let matches = 0;
  for (const term of terms) {
    if (lower.includes(term)) matches++;
  }
  return matches / terms.length;
}

export function reciprocalRankFusion(
  vectorRanks: { id: string }[],
  ftsRanks: { id: string }[],
  k = 60,
): { id: string; rrfScore: number }[] {
  const scores = new Map<string, number>();

  vectorRanks.forEach((item, i) => {
    const prev = scores.get(item.id) ?? 0;
    scores.set(item.id, prev + 1 / (k + i + 1));
  });

  ftsRanks.forEach((item, i) => {
    const prev = scores.get(item.id) ?? 0;
    scores.set(item.id, prev + 1 / (k + i + 1));
  });

  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

export type SimilarityTier = 'high' | 'medium' | 'low' | 'none';

export function getSimilarityTier(
  score: number,
  high: number,
  medium: number,
  low: number,
): SimilarityTier {
  if (score >= high) return 'high';
  if (score >= medium) return 'medium';
  if (score >= low) return 'low';
  return 'none';
}

export type Verdict = 'likely_duplicate' | 'possibly_related' | 'no_match';

export function getVerdict(topScore: number, high: number, medium: number): Verdict {
  if (topScore >= high) return 'likely_duplicate';
  if (topScore >= medium) return 'possibly_related';
  return 'no_match';
}
