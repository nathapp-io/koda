import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { AgentsService } from './agents.service';
import { AgentRouteCommands, AGENT_ROUTE_VARIANTS } from './agent-route.commands';

describe('AgentRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { slug: 'alpha' };
    const service = { removeById: vi.fn().mockResolvedValue(result), update: vi.fn().mockResolvedValue(result), updateCapabilities: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new AgentRouteCommands(registry, service as unknown as AgentsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, service, loader, result };
  }
  it('AC-7: registers update and capabilities commands', () => {
    const { registry } = build();
    expect(registry.get('agent.update', 'rest:agents.update')).toMatchObject({ key: 'agent.update' });
    expect(registry.get('agent.capabilities.update', 'rest:agents.update-capabilities')).toMatchObject({ key: 'agent.capabilities.update' });
  });
  it('AC-9: capabilities update executes against the frozen id without looking up slug', async () => {
    const { registry, service } = build();
    const command = registry.get('agent.capabilities.update', 'rest:agents.update-capabilities');
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'bot', agentId: 'a1', capabilities: { capabilities: ['ts'] } });
    await command.execute(input);
    expect(service.updateCapabilities).toHaveBeenCalledWith('a1', { capabilities: ['ts'] });
    expect(service).not.toHaveProperty('findBySlug');
  });
  it('AC-9: registers the exact deletion variant', () => {
    const { registry } = build();
    expect(registry.get('agent.delete', AGENT_ROUTE_VARIANTS.delete)).toMatchObject({ key: 'agent.delete', variant: 'rest:agents.delete' });
  });
  it('AC-10: parses frozen identifiers, reloads the actor and calls the deletion service', async () => {
    const { registry, service, loader, result } = build();
    const command = registry.get('agent.delete', AGENT_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'alpha', agentId: 'target-1', extra: 1 });
    expect(input).toEqual({ slug: 'alpha', agentId: 'target-1' });
    expect(command.parse(input)).toEqual(input);
    const output = await command.execute(input);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(service.removeById).toHaveBeenCalledExactlyOnceWith('target-1');
    expect(output).toBe(result); expect(command.toResult?.(output)).toBe(result);
    for (const invalid of [null, [], {}, { slug: '' }, { slug: 7 }, { slug: 'alpha' }, { slug: 'alpha', agentId: '' }, { slug: 'alpha', agentId: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
  });
});
