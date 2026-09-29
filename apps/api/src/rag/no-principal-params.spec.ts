import 'reflect-metadata';
import { ROUTE_ARGS_METADATA, CUSTOM_ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RagController } from './rag.controller';
import { RetrievalController } from '../retrieval/retrieval.controller';

/**
 * #145: ProjectMembershipGuard decides access for these handlers, so none of
 * them declares a custom parameter decorator (such as `@Principal()`) that
 * it would never read.
 */
const HANDLERS: Array<[new (...args: never[]) => unknown, string]> = [
  [RagController, 'addDocument'],
  [RagController, 'listDocuments'],
  [RagController, 'deleteDocument'],
  [RagController, 'search'],
  [RagController, 'importGraphify'],
  [RagController, 'optimizeTable'],
  [RetrievalController, 'evaluateRetrieval'],
];

describe('#145 RAG and retrieval handlers take no principal', () => {
  it.each(HANDLERS)('%p.%s has no custom parameter decorator', (controller, method) => {
    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, unknown>;
    expect(Object.keys(args).filter((key) => key.includes(CUSTOM_ROUTE_ARGS_METADATA))).toEqual([]);
  });

  it('the check sees the route params it keeps (not vacuous)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, RagController, 'addDocument') as Record<string, unknown>;
    expect(Object.keys(args).length).toBeGreaterThanOrEqual(2);
  });
});
