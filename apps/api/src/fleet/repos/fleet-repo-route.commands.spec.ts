import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { FleetReposService } from './fleet-repos.service';
import { FleetRepoRouteCommands, FLEET_REPO_ROUTE_VARIANTS } from './fleet-repo-route.commands';

describe('FleetRepoRouteCommands', () => {
  const body = { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' };
  /** The auto-review route's `{ id, patch }` frozen input (US-003). */
  const patch = { enabled: true };
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'r1', repoId: 'r1', reachable: true };
    const repos = {
      create: vi.fn().mockResolvedValue(result),
      remove: vi.fn(),
      check: vi.fn().mockResolvedValue(result),
      configureAutoReview: vi.fn().mockResolvedValue(result),
    };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new FleetRepoRouteCommands(registry, repos as unknown as FleetReposService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, repos, loader, result };
  }

  /**
   * One row per registered route: the variant it freezes, the key it asks under, the raw input it
   * accepts (with the property a body must not smuggle through) and the input it must parse to.
   */
  const cases = [
    { action: 'create', key: 'fleet.repo.create', variant: 'rest:fleet-repos.create', raw: { ...body, extra: 1 }, parsed: body },
    { action: 'delete', key: 'fleet.repo.delete', variant: 'rest:fleet-repos.delete', raw: { id: 'r1' }, parsed: { id: 'r1' } },
    { action: 'check', key: 'fleet.repo.check', variant: 'rest:fleet-repos.check', raw: { id: 'r1' }, parsed: { id: 'r1' } },
    {
      action: 'autoReview', key: 'fleet.repo.review.configure', variant: 'rest:fleet-repos.auto-review',
      raw: { id: 'r1', patch: { ...patch, extra: 1 } }, parsed: { id: 'r1', patch },
    },
  ] as const;
  /** Inputs every variant must refuse: no object, no id, an empty id, a non-string id. */
  const invalidFor = (action: string) => [
    null, [], {}, { id: '' }, { id: 7 },
    ...(action === 'autoReview' ? [{ id: 'r1' }, { id: 'r1', patch: { enabled: 'yes' } }] : []),
  ];

  it('AC-12: registers the four matching variants', () => {
    const { registry } = build();
    expect(Object.values(FLEET_REPO_ROUTE_VARIANTS)).toHaveLength(4);
    for (const { action, key, variant } of cases) {
      expect(registry.get(key, FLEET_REPO_ROUTE_VARIANTS[action])).toMatchObject({ key, variant });
    }
  });

  for (const { action, key, raw, parsed } of cases) {
    it(`${action}: parses, reloads actor, executes and projects the service result`, async () => {
      const { registry, repos, loader, result } = build();
      const command = registry.get(key, FLEET_REPO_ROUTE_VARIANTS[action]);
      if (!command) throw new Error('Missing route command');
      expect(command.parse(raw)).toEqual(parsed);
      expect(command.parse(parsed)).toEqual(parsed);
      const out = await command.execute(parsed);
      expect(loader.forContext).toHaveBeenCalledOnce();
      if (action === 'create') expect(repos.create).toHaveBeenCalledExactlyOnceWith('a1', body);
      if (action === 'check') expect(repos.check).toHaveBeenCalledExactlyOnceWith('r1');
      if (action === 'autoReview') expect(repos.configureAutoReview).toHaveBeenCalledExactlyOnceWith({ id: 'a1' }, 'r1', patch);
      if (action === 'delete') {
        expect(repos.remove).toHaveBeenCalledExactlyOnceWith('a1', 'r1');
        expect(out).toBeNull();
        expect(command.toResult).toBeUndefined();
      } else {
        expect(out).toBe(result);
        expect(command.toResult?.(out)).toBe(result);
      }
      for (const invalid of invalidFor(action)) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    });
  }
});
