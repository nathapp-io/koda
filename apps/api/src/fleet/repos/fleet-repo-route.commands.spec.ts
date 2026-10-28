import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { FleetReposService } from './fleet-repos.service';
import { FleetRepoRouteCommands, FLEET_REPO_ROUTE_VARIANTS } from './fleet-repo-route.commands';

describe('FleetRepoRouteCommands', () => {
  const body = { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' };
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'r1', repoId: 'r1', reachable: true };
    const repos = { create: vi.fn().mockResolvedValue(result), remove: vi.fn(), check: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new FleetRepoRouteCommands(registry, repos as unknown as FleetReposService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, repos, loader, result };
  }
  it('AC-12: registers the three matching variants', () => {
    const { registry } = build();
    expect(Object.values(FLEET_REPO_ROUTE_VARIANTS)).toHaveLength(3);
    for (const action of ['create', 'delete', 'check'] as const) {
      expect(registry.get(`fleet.repo.${action}`, FLEET_REPO_ROUTE_VARIANTS[action])).toMatchObject({ key: `fleet.repo.${action}`, variant: `rest:fleet-repos.${action}` });
    }
  });
  for (const action of ['create', 'delete', 'check'] as const) {
    it(`${action}: parses, reloads actor, executes and projects the service result`, async () => {
      const { registry, repos, loader, result } = build();
      const command = registry.get(`fleet.repo.${action}`, FLEET_REPO_ROUTE_VARIANTS[action]);
      if (!command) throw new Error('Missing route command');
      const parsed = command.parse({ ...(action === 'create' ? body : { id: 'r1' }), extra: 1 });
      expect(parsed).toEqual(action === 'create' ? body : { id: 'r1' });
      expect(command.parse(parsed)).toEqual(parsed);
      const out = await command.execute(parsed);
      expect(loader.forContext).toHaveBeenCalledOnce();
      if (action === 'create') expect(repos.create).toHaveBeenCalledExactlyOnceWith('a1', body);
      if (action === 'check') expect(repos.check).toHaveBeenCalledExactlyOnceWith('r1');
      if (action === 'delete') {
        expect(repos.remove).toHaveBeenCalledExactlyOnceWith('a1', 'r1');
        expect(out).toBeNull();
        expect(command.toResult).toBeUndefined();
      } else {
        expect(out).toBe(result);
        expect(command.toResult?.(out)).toBe(result);
      }
      for (const invalid of [null, [], {}, { id: '' }, { id: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    });
  }
});
