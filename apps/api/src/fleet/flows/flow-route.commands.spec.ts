import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it, vi } from 'vitest';
import { FlowRouteCommands, THREAD_PREAPPROVAL_ROUTE_VARIANTS } from './flow-route.commands';

function setup() {
  const commands = new Map<string, { parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }>();
  const registry = { register: vi.fn((command: { variant: string; parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }) => commands.set(command.variant, command)) };
  const threads = {
    setPreApproval: vi.fn().mockResolvedValue({ preApproval: { userId: 'user-1', at: '2026-01-01T00:00:00.000Z', costCapUsd: '30' } }),
    clearPreApproval: vi.fn().mockResolvedValue(false),
  };
  const user = { actorType: 'user', id: 'user-1' };
  const loader = { forContext: vi.fn().mockResolvedValue(user) };
  new FlowRouteCommands(registry as never, threads as never, loader as never).onModuleInit();
  const command = (variant: string) => {
    const registered = commands.get(variant);
    if (!registered) throw new Error(`missing route command ${variant}`);
    return registered;
  };
  return { command, commands, registry, threads, user, loader };
}

describe('FlowRouteCommands', () => {
  it('AC-2: pins route project/thread and caller id in setPreApproval', async () => {
    const { command: registeredCommand, threads } = setup();
    const command = registeredCommand(THREAD_PREAPPROVAL_ROUTE_VARIANTS.set);
    const input = command.parse({ projectId: 'project-1', threadId: 'thread-1', costCapUsd: 30 });
    await command.execute(input);
    expect(threads.setPreApproval).toHaveBeenCalledOnce();
    expect(threads.setPreApproval).toHaveBeenCalledWith('project-1', 'thread-1', 'user-1', '30');
  });

  it('validates cost cap bounds and decimal precision', () => {
    const command = setup().command(THREAD_PREAPPROVAL_ROUTE_VARIANTS.set);
    for (const costCapUsd of [0, -1, 1000.0001, 1.23456, Number.NaN]) {
      expect(() => command.parse({ projectId: 'p', threadId: 't', costCapUsd })).toThrow(ValidationAppException);
    }
  });

  it('rechecks the actor when a deferred command executes', async () => {
    const { command: registeredCommand, threads, loader } = setup();
    loader.forContext.mockResolvedValue({ actorType: 'agent', id: 'agent-1' });
    const command = registeredCommand(THREAD_PREAPPROVAL_ROUTE_VARIANTS.set);
    await expect(command.execute(command.parse({ projectId: 'p', threadId: 't', costCapUsd: 30 })))
      .rejects.toBeInstanceOf(ForbiddenAppException);
    expect(threads.setPreApproval).not.toHaveBeenCalled();
  });

  it('clears idempotently through the service command', async () => {
    const { command: registeredCommand, threads } = setup();
    const command = registeredCommand(THREAD_PREAPPROVAL_ROUTE_VARIANTS.clear);
    await expect(command.execute(command.parse({ projectId: 'project-1', threadId: 'thread-1' }))).resolves.toBeNull();
    expect(threads.clearPreApproval).toHaveBeenCalledWith('project-1', 'thread-1');
  });
});
