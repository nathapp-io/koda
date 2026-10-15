import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { MemoryGovernanceService } from '../../memory/memory-governance.service';
import { AssistantModule } from './assistant.module';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { KnowledgeTools } from './tools/knowledge-tools';

describe('AssistantModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, AssistantModule] }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('AC-15: compiles and resolves AssistantToolExecutor', () => {
    expect(module.get(AssistantToolExecutor)).toBeDefined();
  });

  it('AC-1 (US-004): provides KnowledgeTools with the memory service it injects', () => {
    // Resolving the group is what proves the provider is registered *and* that MemoryModule (imported for
    // `MemoryGovernanceService`) is in the module graph: the registry is filled by `onModuleInit`, which
    // `compile()` alone does not run (knowledge-tools.spec.ts covers the registration itself).
    expect(module.get(KnowledgeTools)).toBeInstanceOf(KnowledgeTools);
    expect(module.get(MemoryGovernanceService)).toBeInstanceOf(MemoryGovernanceService);
  });
});
