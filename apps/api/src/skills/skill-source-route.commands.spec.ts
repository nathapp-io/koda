import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { SkillsService } from './skills.service';
import { SkillSourceRouteCommands, SKILL_SOURCE_ROUTE_VARIANTS } from './skill-source-route.commands';

describe('SkillSourceRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { slug: 'alpha' };
    const service = { deleteSource: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new SkillSourceRouteCommands(registry, service as unknown as SkillsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, service, loader, result };
  }
  it('AC-9: registers the exact deletion variant', () => {
    const { registry } = build();
    expect(registry.get('skill.source.delete', SKILL_SOURCE_ROUTE_VARIANTS.delete)).toMatchObject({ key: 'skill.source.delete', variant: 'rest:admin-skill-sources.delete' });
  });
  it('AC-10: parses frozen identifiers, reloads the actor and calls the deletion service', async () => {
    const { registry, service, loader } = build();
    const command = registry.get('skill.source.delete', SKILL_SOURCE_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ id: 'alpha', extra: 1 });
    expect(input).toEqual({ id: 'alpha' });
    expect(command.parse(input)).toEqual(input);
    const output = await command.execute(input);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(service.deleteSource).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(output).toBeNull(); expect(command.toResult).toBeUndefined();
    for (const invalid of [null, [], {}, { id: '' }, { id: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
  });
});
