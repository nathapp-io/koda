import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeChunkStore } from './knowledge-chunk-store';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeModule } from './knowledge.module';
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

  it('exports the service only', () => {
    const exportsOf = Reflect.getMetadata('exports', KnowledgeModule) as unknown[];
    expect(exportsOf).toEqual([KnowledgeIndexService]);
  });
});
