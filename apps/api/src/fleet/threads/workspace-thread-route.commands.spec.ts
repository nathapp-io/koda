import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { WorkspaceThreadRouteCommands, WORKSPACE_THREAD_ROUTE_VARIANTS } from './workspace-thread-route.commands';

describe('WorkspaceThreadRouteCommands', () => {
  it('AC-7: registers the global workspace create and archive route variants', () => {
    const registry = new ApprovalCommandRegistry();
    const service = { create: vi.fn(), archive: vi.fn(), get: vi.fn() } as unknown as WorkspaceThreadsService;
    const commands = new WorkspaceThreadRouteCommands(registry, service, {} as ActorPrincipalLoader);

    commands.onModuleInit();

    expect(registry.get('thread.workspace.create', WORKSPACE_THREAD_ROUTE_VARIANTS.create)).toMatchObject({
      key: 'thread.workspace.create', variant: 'rest:workspace-threads.create',
    });
    expect(registry.get('thread.workspace.archive', WORKSPACE_THREAD_ROUTE_VARIANTS.archive)).toMatchObject({
      key: 'thread.workspace.archive', variant: 'rest:workspace-threads.archive',
    });
  });
});
