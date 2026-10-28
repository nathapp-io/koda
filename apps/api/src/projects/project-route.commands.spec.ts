import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { ProjectsService } from './projects.service';
import { ProjectRouteCommands, PROJECT_ROUTE_VARIANTS } from './project-route.commands';

describe('ProjectRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { slug: 'alpha' };
    const service = { softDeleteById: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new ProjectRouteCommands(registry, service as unknown as ProjectsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, service, loader, result };
  }
  it('AC-9: registers the exact deletion variant', () => {
    const { registry } = build();
    expect(registry.get('project.delete', PROJECT_ROUTE_VARIANTS.delete)).toMatchObject({ key: 'project.delete', variant: 'rest:projects.delete' });
  });
  it('AC-10: parses frozen identifiers, reloads the actor and calls the deletion service', async () => {
    const { registry, service, loader } = build();
    const command = registry.get('project.delete', PROJECT_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing command');
    const input = command.parse({ slug: 'alpha', projectId: 'target-1', extra: 1 });
    expect(input).toEqual({ slug: 'alpha', projectId: 'target-1' });
    expect(command.parse(input)).toEqual(input);
    const output = await command.execute(input);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(service.softDeleteById).toHaveBeenCalledExactlyOnceWith('target-1');
    expect(output).toBeNull(); expect(command.toResult).toBeUndefined();
    for (const invalid of [null, [], {}, { slug: '' }, { slug: 7 }, { slug: 'alpha' }, { slug: 'alpha', projectId: '' }, { slug: 'alpha', projectId: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
  });
});
