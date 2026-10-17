import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { MemoryGovernanceService } from '../../memory/memory-governance.service';
import { ProjectsService } from '../../projects/projects.service';
import { AssistantModule } from './assistant.module';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { KODA_GET_ACTION, KODA_MY_PROJECTS } from './koda-tool-descriptors';
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

  it('AC-14 (US-003): init() registers koda_my_projects as the workspace-scoped KODA_MY_PROJECTS tool', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_my_projects');
    expect(tool?.descriptor).toBe(KODA_MY_PROJECTS);
    expect(tool?.scope).toBe('workspace');
  });

  it('AC-14 (US-003): ProjectsService is in the module graph for the workspace tool group', () => {
    expect(module.get(ProjectsService)).toBeInstanceOf(ProjectsService);
  });

  it('AC-16 (US-003): init() registers koda_add_comment as a write tool', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_add_comment');
    expect(tool?.kind).toBe('write');
    expect(tool?.permission).toEqual({ kind: 'ability', action: 'create', subject: 'Comment' });
  });

  it('AC-16 (US-003): init() registers koda_get_action as the member-scoped read tool', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_get_action');
    expect(tool?.descriptor).toBe(KODA_GET_ACTION);
    expect(tool?.kind).toBeUndefined();
    expect(tool?.permission).toEqual({ kind: 'member' });
  });
});
