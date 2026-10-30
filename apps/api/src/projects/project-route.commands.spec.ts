import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { ProjectsService } from './projects.service';
import { ProjectRouteCommands, PROJECT_ROUTE_VARIANTS } from './project-route.commands';

describe('ProjectRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { slug: 'alpha' };
    const service = {
      create: vi.fn().mockResolvedValue(result),
      update: vi.fn().mockResolvedValue(result),
      softDeleteById: vi.fn().mockResolvedValue(result),
      updateRosteredAgent: vi.fn().mockResolvedValue(result),
    };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new ProjectRouteCommands(registry, service as unknown as ProjectsService, loader as unknown as ActorPrincipalLoader, service as never).onModuleInit();
    return { registry, service, loader, result };
  }
  it('refuses secret-bearing input before it can be frozen or serialized', () => {
    const { registry } = build();
    const command = registry.get('project.update', PROJECT_ROUTE_VARIANTS.update);
    if (!command) throw new Error('Missing command');
    for (const ciWebhookToken of ['s'.repeat(32), '', null]) {
      expect(() => command.parse({ slug: 'alpha', patch: { ciWebhookToken } })).toThrow(ValidationAppException);
    }
    expect(command.parse({ slug: 'alpha', patch: { name: 'Safe' } })).toEqual({ slug: 'alpha', patch: { name: 'Safe' } });
  });
  it('AC-11: registers a secret-aware update command that redacts strings and preserves null', () => {
    const { registry } = build();
    const command = registry.get('project.update', 'rest:projects.update-ci-token');
    expect(command).toBeDefined();
    expect(command?.key).toBe('project.update');
    expect(command?.redeem?.redact({ slug: 'a', patch: { ciWebhookToken: 's'.repeat(32), name: 'N' } })).toEqual({
      slug: 'a', patch: { ciWebhookToken: '<redacted>', name: 'N' },
    });
    expect(command?.redeem?.redact({ slug: 'a', patch: { ciWebhookToken: null } })).toEqual({
      slug: 'a', patch: { ciWebhookToken: null },
    });
  });
  it('AC-7: registers the rostered agent update command', () => {
    const { registry } = build();
    expect(registry.get('agent.update', PROJECT_ROUTE_VARIANTS.updateAgent)).toMatchObject({ key: 'agent.update' });
  });
  it('AC-10: command rechecks roster and calls updateRosteredAgent', async () => {
    const { registry, service } = build();
    const command = registry.get('agent.update', PROJECT_ROUTE_VARIANTS.updateAgent);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'alpha', agentSlug: 'bot', projectId: 'p1', agentId: 'a1', patch: { status: 'PAUSED' } });
    await command.execute(input);
    expect(service.updateRosteredAgent).toHaveBeenCalledExactlyOnceWith('alpha', 'bot', { status: 'PAUSED' }, 'p1', 'a1');
  });
  it('AC-8: registers create, update and delete variants', () => {
    const { registry } = build();
    expect(registry.get('project.create', PROJECT_ROUTE_VARIANTS.create)).toMatchObject({ key: 'project.create', variant: 'rest:projects.create' });
    expect(registry.get('project.update', PROJECT_ROUTE_VARIANTS.update)).toMatchObject({ key: 'project.update', variant: 'rest:projects.update' });
    expect(registry.get('project.delete', PROJECT_ROUTE_VARIANTS.delete)).toMatchObject({ key: 'project.delete', variant: 'rest:projects.delete' });
  });
  it('AC-10: parses frozen identifiers, reloads the actor and calls the deletion service', async () => {
    const { registry, service, loader } = build();
    const command = registry.get('project.delete', PROJECT_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'alpha', projectId: 'target-1', extra: 1 });
    expect(input).toEqual({ projectId: 'target-1' });
    expect(command.parse(input)).toEqual(input);
    const output = await command.execute(input);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(service.softDeleteById).toHaveBeenCalledExactlyOnceWith('target-1');
    expect(output).toBeNull(); expect(command.toResult).toBeUndefined();
    for (const invalid of [null, [], {}, { slug: '' }, { slug: 7 }, { slug: 'alpha' }, { projectId: '' }, { projectId: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
  });
});
