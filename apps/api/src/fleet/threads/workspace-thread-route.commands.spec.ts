import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { WorkspaceThreadRouteCommands, WORKSPACE_THREAD_ROUTE_VARIANTS } from './workspace-thread-route.commands';

describe('WorkspaceThreadRouteCommands', () => {
  it('AC-7: registers the four home-scoped route commands with execution key rechecks skipped', () => {
    const registry = new ApprovalCommandRegistry();
    const service = { create: vi.fn(), archive: vi.fn(), get: vi.fn(), updateCap: vi.fn(), stop: vi.fn(), endSession: vi.fn(), answer: vi.fn() } as unknown as WorkspaceThreadsService;
    const commands = new WorkspaceThreadRouteCommands(registry, service, {} as ActorPrincipalLoader);
    commands.onModuleInit();

    for (const [key, variant] of [
      ['thread.cap.update', 'rest:workspace-threads.update'],
      ['thread.stop', 'rest:workspace-threads.stop'],
      ['thread.end-session', 'rest:workspace-threads.end-session'],
      ['thread.answer', 'rest:workspace-threads.answer'],
    ]) {
      expect(registry.get(key, variant)).toMatchObject({ key, variant, skipKeyRecheck: true });
    }
  });

  it('AC-5: registers the global workspace message command without prepare', () => {
    const registry = new ApprovalCommandRegistry();
    const service = { sendMessage: vi.fn() } as unknown as WorkspaceThreadsService;
    const commands = new WorkspaceThreadRouteCommands(registry, service, {} as ActorPrincipalLoader);
    commands.onModuleInit();

    const command = registry.get('thread.workspace.message.send', WORKSPACE_THREAD_ROUTE_VARIANTS.message);
    expect(command).toMatchObject({ key: 'thread.workspace.message.send', variant: 'rest:workspace-threads.message' });
    expect(command?.prepare).toBeUndefined();
  });

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
