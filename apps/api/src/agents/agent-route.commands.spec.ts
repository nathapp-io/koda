import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { AgentsService } from './agents.service';
import { AgentRouteCommands, AGENT_ROUTE_VARIANTS } from './agent-route.commands';

describe('AgentRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { slug: 'alpha' };
    const credential = { apiKey: 'k'.repeat(64), agent: { id: 'a1', slug: 'alpha' } };
    const service = { updateById: vi.fn().mockResolvedValue(result), removeById: vi.fn().mockResolvedValue(result), update: vi.fn().mockResolvedValue(result), updateCapabilities: vi.fn().mockResolvedValue(result), generateApiKey: vi.fn().mockResolvedValue(credential) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new AgentRouteCommands(registry, service as unknown as AgentsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, service, loader, result, credential };
  }
  it('US-006: registers the two credential variants as redeem commands', () => {
    const { registry } = build();
    const create = registry.get('agent.create', AGENT_ROUTE_VARIANTS.create);
    const rotate = registry.get('agent.key.rotate', AGENT_ROUTE_VARIANTS.rotateKey);
    expect(create).toMatchObject({ key: 'agent.create', variant: 'rest:agents.create' });
    expect(rotate).toMatchObject({ key: 'agent.key.rotate', variant: 'rest:agents.rotate-key' });
    // An approval only releases the request: the key is minted when the requester redeems it.
    expect(create?.redeem).toEqual({});
    expect(rotate?.redeem).toEqual({});
  });
  it('US-006: the create command parses the body, mints the key and stores the agent only', async () => {
    const { registry, service, credential } = build();
    const command = registry.get('agent.create', AGENT_ROUTE_VARIANTS.create);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ agent: { name: 'Subrina', slug: 'subrina-coder', capabilities: ['nax'] } });
    expect(input).toEqual({ agent: { name: 'Subrina', slug: 'subrina-coder', capabilities: ['nax'] } });
    expect(command.parse(input)).toEqual(input);
    const output = await command.execute(input);
    expect(service.generateApiKey).toHaveBeenCalledExactlyOnceWith({ name: 'Subrina', slug: 'subrina-coder', capabilities: ['nax'] });
    expect(command.toResult?.(output)).toEqual({ agent: credential.agent });
    for (const invalid of [null, [], {}, { agent: {} }, { agent: { name: 'Subrina', slug: 'Bad Slug!' } }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
  });
  it('US-006: the rotate command rotates the frozen id, never the reusable slug', async () => {
    const { registry, service, credential } = build();
    const command = registry.get('agent.key.rotate', AGENT_ROUTE_VARIANTS.rotateKey);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'alpha', agentId: 'target-1', redeem: 'r1' });
    expect(input).toEqual({ slug: 'alpha', agentId: 'target-1' });
    const output = await command.execute(input);
    expect(service.generateApiKey).toHaveBeenCalledExactlyOnceWith('target-1');
    expect(command.toResult?.(output)).toEqual({ agent: credential.agent });
    for (const invalid of [null, [], {}, { slug: 'alpha' }, { slug: '', agentId: 'a1' }, { slug: 'alpha', agentId: 7 }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
  });
  it('AC-7: registers update and capabilities commands', () => {
    const { registry } = build();
    expect(registry.get('agent.update', 'rest:agents.update')).toMatchObject({ key: 'agent.update' });
    expect(registry.get('agent.capabilities.update', 'rest:agents.update-capabilities')).toMatchObject({ key: 'agent.capabilities.update' });
  });
  it('update executes only against the frozen id, never the reusable slug', async () => {
    const { registry, service } = build();
    const command = registry.get('agent.update', AGENT_ROUTE_VARIANTS.update);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'bot', agentId: 'original', patch: { name: 'renamed' } });
    expect(input).toEqual({ slug: 'bot', agentId: 'original', patch: { name: 'renamed' } });
    await command.execute(input);
    expect(service.updateById).toHaveBeenCalledWith('original', { name: 'renamed' });
    expect(service.update).not.toHaveBeenCalled();
    expect(() => command.parse({ slug: 'bot', patch: {} })).toThrow(ValidationAppException);
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
