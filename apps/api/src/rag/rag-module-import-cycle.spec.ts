/**
 * Regression pin for the US-006 fix round (the scoped run's `Nest can't resolve dependencies of the RagService (?, …)`
 * gate failure).
 *
 * `rag.service.ts` and `vector-store.service.ts` imported each other for runtime values: the FTS/RRF scoring helpers
 * lived on `rag.service` and `vector-store` (and `hybrid-retriever`) imported them. With the DB suite's shared module
 * cache (`isolate: false`, `test/vitest-db-projects.ts`) whichever spec entered the pair first decided whether
 * `RagService`'s `design:paramtypes[0]` was the real `VectorStore` class or `undefined`, so
 * `Test.createTestingModule({ providers: [RagService, VectorStore] })` failed intermittently and the scoped command
 * exited 1.
 *
 * The scoring helpers moved to `rag-scoring.ts`, which depends on nothing, so the cycle is gone. It must stay gone:
 * `vector-store.service.ts` may reference `rag.service` for types only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Imported before `RagService` on purpose: this is the order that used to poison the DI metadata.
import { VectorStore } from './vector-store.service';
import { RagService } from './rag.service';

/** Module specifiers a file imports as runtime values (`import type` clauses are erased and excluded). */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const statement = /^[ \t]*import[ \t]+(?!type\b)([^'"]*?)from[ \t]*['"]([^'"]+)['"]/gms;
  for (const match of source.matchAll(statement)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

describe('rag module import graph', () => {
  it('vector-store.service.ts imports rag.service as types only, so the two modules are not a runtime cycle', () => {
    const source = readFileSync(join(__dirname, 'vector-store.service.ts'), 'utf8');

    expect(valueImportSpecifiers(source)).not.toContain('./rag.service');
  });

  it('RagService carries the real VectorStore class in its DI metadata', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paramtypes = (Reflect as any).getMetadata('design:paramtypes', RagService) as unknown[] | undefined;

    expect(paramtypes?.[0]).toBe(VectorStore);
  });
});
