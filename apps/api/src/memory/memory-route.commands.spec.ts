import { MemoryRouteCommands, MEMORY_ROUTE_VARIANTS } from './memory-route.commands';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { MemoryWriteService } from './memory-write.service';
import { MemoryKind } from '../common/enums';

describe('MemoryRouteCommands', () => {
  it('AC-8 registers all memory REST key and variant pairs', () => {
    const registered = new Map<string, { key: string; variant: string }>();
    const registry = { register: vi.fn((command: { key: string; variant: string }) => registered.set(`${command.key}:${command.variant}`, command)) };
    const service = { create: vi.fn(), recordDecision: vi.fn(), extract: vi.fn() };
    const loader = {};
    new MemoryRouteCommands(registry as unknown as ApprovalCommandRegistry, service as unknown as MemoryWriteService, loader as ActorPrincipalLoader).onModuleInit();

    for (const [key, variant] of [
      ['memory.create', 'rest:memory.create'],
      ['memory.decision.record', 'rest:memory.decisions.record'],
      ['memory.extract', 'rest:memory.extract'],
      ['memory.decision.retire', 'rest:memory.decision.retire'],
    ]) {
      expect(registered.get(`${key}:${variant}`)).toMatchObject({ key, variant });
    }
    expect(registered.size).toBe(4);
    expect(MEMORY_ROUTE_VARIANTS).toEqual({ create: 'rest:memory.create', recordDecision: 'rest:memory.decisions.record', extract: 'rest:memory.extract', retire: 'rest:memory.decision.retire' });
  });

  it('reloads the principal and executes retirement with a validated reason', async () => {
    const registered = new Map<string, { parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }>();
    const registry = { register: vi.fn((command: { key: string; parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }) => registered.set(command.key, command)) };
    const principal = { actorType: 'user', id: 'u1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { retireDecision: vi.fn().mockResolvedValue({ id: 'm1', status: 'rejected' }) };
    new MemoryRouteCommands(registry as unknown as ApprovalCommandRegistry, service as unknown as MemoryWriteService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registered.get('memory.decision.retire');
    if (!command) throw new Error('retirement command not registered');
    expect(() => command.parse({ id: '', body: {} })).toThrow();
    expect(() => command.parse({ id: 'm1', body: { reason: 'x'.repeat(501) } })).toThrow();
    await expect(command.execute(command.parse({ id: 'm1', body: { reason: 'wrong call' } }))).resolves.toEqual({ id: 'm1', status: 'rejected' });
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(service.retireDecision).toHaveBeenCalledWith(principal, 'm1', 'wrong call');
  });

  it('AC-9 runs memory.create with the rebuilt principal and parsed memory DTO', async () => {
    const registered = new Map<string, { parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }>();
    const registry = { register: vi.fn((command: { key: string; variant: string; parse(input: unknown): unknown; execute(input: unknown): Promise<unknown> }) => { registered.set(command.key, command); }) };
    const principal = { actorType: 'agent', id: 'agent-1', slug: 'agent', status: 'ACTIVE', capabilities: [], authorities: [], agentRoles: [] };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const memoryWrites = { create: vi.fn().mockResolvedValue({ id: 'memory-1' }), recordDecision: vi.fn(), extract: vi.fn() };
    new MemoryRouteCommands(registry as unknown as ApprovalCommandRegistry, memoryWrites as unknown as MemoryWriteService, loader as unknown as ActorPrincipalLoader).onModuleInit();

    const command = registered.get('memory.create');
    const parsed = command?.parse({ memory: { projectId: 'p1', kind: 'FACT', subject: 's', predicate: 'p' } });
    await command?.execute(parsed);
    expect(memoryWrites.create).toHaveBeenCalledWith(principal, expect.objectContaining({ projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p' }));
  });
});
