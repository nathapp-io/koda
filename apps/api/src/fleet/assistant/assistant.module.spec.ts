import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { MemoryGovernanceService } from '../../memory/memory-governance.service';
import { ProjectsService } from '../../projects/projects.service';
import { AssistantActionPort } from '../approvals/assistant-action.port';
import { ApprovalsService } from '../approvals/approvals.service';
import { AssistantActionDecisions } from './actions/assistant-action-decisions';
import { PendingActionExpirySweeper } from './actions/pending-action-expiry.sweeper';
import { PrismaPendingActionRepository } from './actions/prisma-pending-action.repository';
import { AssistantModule } from './assistant.module';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { KODA_GET_ACTION, KODA_MY_PROJECTS } from './koda-tool-descriptors';
import { KnowledgeTools } from './tools/knowledge-tools';
import { MemoryWriteTools } from './tools/memory-write-tools';

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

  it('AC-11 (US-003): init() registers koda_create_tickets as a write tool needing create Ticket', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_create_tickets');
    expect(tool?.kind).toBe('write');
    expect(tool?.permission).toEqual({ kind: 'ability', action: 'create', subject: 'Ticket' });
  });

  it('AC-13 (US-004): init() registers koda_update_ticket as a write tool needing update Ticket', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_update_ticket');
    expect(tool?.kind).toBe('write');
    expect(tool?.permission).toEqual({ kind: 'ability', action: 'update', subject: 'Ticket' });
  });

  it('AC-11 (US-005): init() registers koda_link_tickets as a write tool that needs membership only', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_link_tickets');
    expect(tool?.kind).toBe('write');
    expect(tool?.permission).toEqual({ kind: 'member' });
  });

  it('AC-9 (US-006): init() registers koda_add_memory as a write tool that needs membership only', async () => {
    // The group is what fills the entry: resolving it proves the provider is registered and that MemoryModule
    // (which exports the repository it upserts through) is in the module graph.
    expect(module.get(MemoryWriteTools)).toBeInstanceOf(MemoryWriteTools);

    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_add_memory');
    expect(tool?.kind).toBe('write');
    expect(tool?.permission).toEqual({ kind: 'member' });
  });

  it('AC-16 (US-003): init() registers koda_get_action as the member-scoped read tool', async () => {
    await module.init();

    const tool = module.get(AssistantToolRegistry).get('koda_get_action');
    expect(tool?.descriptor).toBe(KODA_GET_ACTION);
    expect(tool?.kind).toBeUndefined();
    expect(tool?.permission).toEqual({ kind: 'member' });
  });

  it('US-007: provides the action expiry sweeper, which resolves the decide handler and the action repository', () => {
    const sweeper = module.get(PendingActionExpirySweeper);
    expect(sweeper).toBeInstanceOf(PendingActionExpirySweeper);
    expect((sweeper as unknown as { actions: unknown }).actions).toBeInstanceOf(PrismaPendingActionRepository);
    expect((sweeper as unknown as { decisions: unknown }).decisions).toBeInstanceOf(AssistantActionDecisions);
  });

  it('US-005: ApprovalsService and AssistantActionDecisions share one AssistantActionPort instance', () => {
    const port = module.get(AssistantActionPort);
    expect(port).toBeInstanceOf(AssistantActionPort);
    expect((module.get(ApprovalsService) as unknown as { assistantActions: unknown }).assistantActions).toBe(port);
    expect((module.get(AssistantActionDecisions) as unknown as { port: unknown }).port).toBe(port);
  });

  it('US-005: init() registers the decide handler, so the port forwards to it', async () => {
    const decisions = module.get(AssistantActionDecisions);
    const decide = vi.spyOn(decisions, 'decide').mockResolvedValue({ id: 'a1' } as never);
    const port = module.get(AssistantActionPort);
    expect(() => port.decide({ id: 'u1', globalAdmin: false }, { id: 'a1' } as never, { decision: 'reject' }, new Date())).toThrow(expect.objectContaining({ prefix: 'threads.disabled' }));

    await module.init();
    await port.decide({ id: 'u1', globalAdmin: false }, { id: 'a1' } as never, { decision: 'reject' }, new Date());

    expect(decide).toHaveBeenCalledTimes(1);
  });
});
