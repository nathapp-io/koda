import 'reflect-metadata';
import { ROUTE_ARGS_METADATA, CUSTOM_ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RagController } from './rag.controller';
import { RetrievalController } from '../retrieval/retrieval.controller';

/**
 * #145: no handler declares a custom parameter decorator (such as `@Principal()`) that it would never read.
 *
 * Permissions P1 US-007 moved two handlers off this list: `addDocument` records the caller as the row's creator
 * and `deleteDocument` reads it for the per-row ownership check, so both take `@Principal() principal` and read it.
 * The other five still decide access in the guard chain alone.
 */
const HANDLERS: Array<[new (...args: never[]) => unknown, string]> = [
  [RagController, 'listDocuments'],
  [RagController, 'search'],
  [RagController, 'importGraphify'],
  [RagController, 'optimizeTable'],
  [RetrievalController, 'evaluateRetrieval'],
];

describe('#145 RAG and retrieval handlers take no unused principal', () => {
  it.each(HANDLERS)('%p.%s has no custom parameter decorator', (controller, method) => {
    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, unknown>;
    expect(Object.keys(args).filter((key) => key.includes(CUSTOM_ROUTE_ARGS_METADATA))).toEqual([]);
  });

  it('the check sees the route params it keeps (not vacuous)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RagController, 'listDocuments') as Record<string, unknown>;
    expect(Object.keys(args).length).toBeGreaterThanOrEqual(2);
  });

  it('US-007: the two KB write handlers do declare and read a principal', () => {
    for (const method of ['addDocument', 'deleteDocument']) {
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, RagController, method) ?? {}) as Record<string, unknown>;
      expect(Object.keys(args).filter((key) => key.includes(CUSTOM_ROUTE_ARGS_METADATA))).toHaveLength(1);
    }
  });
});
