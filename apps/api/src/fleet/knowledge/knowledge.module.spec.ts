import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeIndexAdmin } from './knowledge-index-admin.service';
import { KnowledgeRouteCommands } from './knowledge-route.commands';
import { KnowledgeChunkStore } from './knowledge-chunk-store';
import { KnowledgeIndexQueue } from './knowledge-index.queue';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgePoller } from './knowledge-poller';
import { KnowledgeSearchService } from './knowledge-search.service';
import { ProjectKnowledgeController } from './project-knowledge.controller';
import { KnowledgeModule } from './knowledge.module';
import { KnowledgeRepoIndexer } from './knowledge-repo-indexer';
import { KNOWLEDGE_INDEX_REPOSITORY } from './knowledge-index.domain';

describe('KnowledgeModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, KnowledgeModule] }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('compiles and resolves KnowledgeChunkStore (AC-3)', () => {
    expect(module.get(KnowledgeChunkStore, { strict: false })).toBeInstanceOf(KnowledgeChunkStore);
  });

  it('resolves the service face over the module-private repository', () => {
    expect(module.get(KnowledgeIndexService)).toBeInstanceOf(KnowledgeIndexService);
    expect(module.get(KNOWLEDGE_INDEX_REPOSITORY, { strict: false })).toBeDefined();
  });

  it('resolves the search service and the project knowledge controller (US-002)', () => {
    expect(module.get(KnowledgeSearchService)).toBeInstanceOf(KnowledgeSearchService);
    expect(module.get(ProjectKnowledgeController, { strict: false })).toBeInstanceOf(ProjectKnowledgeController);
  });

  it('resolves the private repository indexer (US-004)', () => {
    expect(module.get(KnowledgeRepoIndexer)).toBeInstanceOf(KnowledgeRepoIndexer);
    expect(Reflect.getMetadata('exports', KnowledgeModule)).not.toContain(KnowledgeRepoIndexer);
  });

  it('resolves the queue and the poller, both module-private (the triggers reach the queue by event)', () => {
    expect(module.get(KnowledgeIndexQueue)).toBeInstanceOf(KnowledgeIndexQueue);
    expect(module.get(KnowledgePoller)).toBeInstanceOf(KnowledgePoller);
    expect(Reflect.getMetadata('exports', KnowledgeModule)).not.toContain(KnowledgePoller);
  });

  it('resolves the knowledge admin and route commands', () => {
    expect(module.get(KnowledgeIndexAdmin)).toBeInstanceOf(KnowledgeIndexAdmin);
    expect(module.get(KnowledgeRouteCommands)).toBeInstanceOf(KnowledgeRouteCommands);
  });

  it('exports the two services only', () => {
    const exportsOf = Reflect.getMetadata('exports', KnowledgeModule) as unknown[];
    expect(exportsOf).toEqual([KnowledgeIndexService, KnowledgeSearchService]);
  });
});
