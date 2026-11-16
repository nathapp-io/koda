import { ValidationAppException } from '@nathapp/nestjs-common';
import { REDACTED_SECRET } from '../../approvals/route/redact-secret';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { FleetReposService } from './fleet-repos.service';
import { FleetRepoRouteCommands, FLEET_REPO_ROUTE_VARIANTS } from './fleet-repo-route.commands';

describe('FleetRepoRouteCommands', () => {
  const body = { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' };
  /** The auto-review route's `{ id, patch }` frozen input (US-003). */
  const patch = { enabled: true };
  /** The fix-checks route's `{ id, patch }` frozen input (US-001). */
  const fixPatch = { trustDetectedChecks: true };
  /** The fix-unprotected route's `{ id, patch }` frozen input. */
  const unprotectedPatch = { allowUnprotected: true };
  /** The rule-override set route's `{ id, body }` frozen input (US-007). */
  const ruleBody = { rules: [{ path: 'api.md', content: 'answer with the summary' }], rulesMode: 'merge' };
  /** The GitLab credential rotation route's `{ id, patch }` frozen input (US-005). */
  const credentialsPatch = { writeToken: 'glpat-write' };
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'r1', repoId: 'r1', reachable: true };
    const repos = {
      create: vi.fn().mockResolvedValue(result),
      remove: vi.fn(),
      check: vi.fn().mockResolvedValue(result),
      configureAutoReview: vi.fn().mockResolvedValue(result),
      configureFixChecks: vi.fn().mockResolvedValue(result),
      configureFixUnprotected: vi.fn().mockResolvedValue(result),
      setRuleOverride: vi.fn().mockResolvedValue(result),
      clearRuleOverride: vi.fn().mockResolvedValue(result),
      rotateGitlabCredentials: vi.fn().mockResolvedValue(result),
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
    {
      action: 'fixChecks', key: 'fleet.repo.review.configure', variant: 'rest:fleet-repos.fix-checks',
      raw: { id: 'r1', patch: { ...fixPatch, extra: 1 } }, parsed: { id: 'r1', patch: fixPatch },
    },
    {
      action: 'fixUnprotected', key: 'fleet.repo.fix.unprotected', variant: 'rest:fleet-repos.fix-unprotected',
      raw: { id: 'r1', patch: { ...unprotectedPatch, extra: 1 } }, parsed: { id: 'r1', patch: unprotectedPatch },
    },
    {
      action: 'ruleOverrideSet', key: 'fleet.repo.rules.configure', variant: 'rest:fleet-repos.rule-override.set',
      raw: { id: 'r1', body: ruleBody }, parsed: { id: 'r1', body: ruleBody },
    },
    {
      action: 'ruleOverrideClear', key: 'fleet.repo.rules.configure', variant: 'rest:fleet-repos.rule-override.clear',
      raw: { id: 'r1' }, parsed: { id: 'r1' },
    },
    {
      action: 'gitlabCredentials', key: 'fleet.repo.credentials.update', variant: 'rest:fleet-repos.gitlab-credentials',
      raw: { id: 'r1', patch: { ...credentialsPatch, extra: 1 } }, parsed: { id: 'r1', patch: credentialsPatch },
    },
  ] as const;
  /** Inputs every variant must refuse: no object, no id, an empty id, a non-string id. */
  const invalidFor = (action: string) => [
    null, [], {}, { id: '' }, { id: 7 },
    ...(action === 'autoReview' ? [{ id: 'r1' }, { id: 'r1', patch: { enabled: 'yes' } }] : []),
    ...(action === 'fixChecks' ? [{ id: 'r1' }, { id: 'r1', patch: { trustDetectedChecks: 'yes' } }] : []),
    ...(action === 'fixUnprotected' ? [{ id: 'r1' }, { id: 'r1', patch: { allowUnprotected: 'yes' } }] : []),
    ...(action === 'ruleOverrideSet' ? [{ id: 'r1' }, { id: 'r1', body: { rules: 'nope' } }] : []),
    ...(action === 'gitlabCredentials' ? [{ id: 'r1', patch: { writeToken: 5 } }, { id: 'r1', patch: { confirmBotAccount: 'yes' } }] : []),
  ];

  it('AC-12: registers the nine matching variants', () => {
    const { registry } = build();
    expect(Object.values(FLEET_REPO_ROUTE_VARIANTS)).toHaveLength(9);
    for (const { action, key, variant } of cases) {
      expect(registry.get(key, FLEET_REPO_ROUTE_VARIANTS[action])).toMatchObject({ key, variant });
    }
  });

  /**
   * US-004 AC-14: the GitLab create carries the two tokens, so the command redacts them: neither
   * the approval request row nor the hash a redemption compares against ever holds a token.
   */
  it('AC-14: the create command redacts the two tokens and leaves every other field unchanged', () => {
    const { registry } = build();
    const command = registry.get('fleet.repo.create', FLEET_REPO_ROUTE_VARIANTS.create);
    const input = {
      projectSlug: 'web', provider: 'gitlab', owner: 'acme', name: 'app',
      host: 'https://gitlab.example.com', readToken: 'glpat-read', writeToken: 'glpat-write', confirmBotAccount: true,
    };
    expect(command?.redeem?.redact?.(input)).toEqual({
      ...input, readToken: REDACTED_SECRET, writeToken: REDACTED_SECRET,
    });
  });

  it('AC-14: a body without a token has nothing to redact', () => {
    const { registry } = build();
    const command = registry.get('fleet.repo.create', FLEET_REPO_ROUTE_VARIANTS.create);
    const input = { projectSlug: 'web', provider: 'gitlab', owner: 'acme', name: 'app' };
    expect(command?.redeem?.redact?.(input)).toEqual(input);
  });

  /**
   * US-004: the engine's redeem mode is command-wide, and a redeem command never runs when its
   * request is approved — it waits for the requester to redeem it. The create body carries a token
   * only when it names a GitLab repo, so the command redeems only when its redaction removed one:
   * a GitHub body keeps the ordinary flow, and an approved request registers the repo as before.
   */
  it('US-004: the create command redeems only when its redaction removed a token', () => {
    const { registry } = build();
    const command = registry.get('fleet.repo.create', FLEET_REPO_ROUTE_VARIANTS.create);
    expect(command?.redeem?.onlyWhenRedacted).toBe(true);
  });

  /**
   * US-005 AC-10: the rotation carries a token, so its command redacts it: neither the approval
   * request row nor the hash a redemption compares against ever holds a token. A token the body
   * does not carry stays absent — the redaction adds no key for it.
   */
  it('AC-10: the rotation command redacts every token it carries and leaves an absent token absent', () => {
    const { registry } = build();
    const command = registry.get('fleet.repo.credentials.update', FLEET_REPO_ROUTE_VARIANTS.gitlabCredentials);

    expect(command?.redeem?.redact?.({ id: 'r1', patch: { writeToken: 'glpat-write', readToken: 'glpat-read' } }))
      .toStrictEqual({ id: 'r1', patch: { writeToken: REDACTED_SECRET, readToken: REDACTED_SECRET } });

    const writeOnly = command?.redeem?.redact?.({ id: 'r1', patch: { writeToken: 'glpat-write' } });
    expect(writeOnly).toStrictEqual({ id: 'r1', patch: { writeToken: REDACTED_SECRET } });
    expect(Object.keys((writeOnly as { patch: Record<string, unknown> }).patch)).toEqual(['writeToken']);
  });

  it('AC-10: the rotation command keeps the fields that are not tokens', () => {
    const { registry } = build();
    const command = registry.get('fleet.repo.credentials.update', FLEET_REPO_ROUTE_VARIANTS.gitlabCredentials);

    expect(command?.redeem?.redact?.({ id: 'r1', patch: { writeToken: 'glpat-write', confirmBotAccount: true } }))
      .toStrictEqual({ id: 'r1', patch: { writeToken: REDACTED_SECRET, confirmBotAccount: true } });
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
      if (action === 'fixChecks') expect(repos.configureFixChecks).toHaveBeenCalledExactlyOnceWith({ id: 'a1' }, 'r1', fixPatch);
      if (action === 'fixUnprotected') expect(repos.configureFixUnprotected).toHaveBeenCalledExactlyOnceWith({ id: 'a1' }, 'r1', unprotectedPatch);
      if (action === 'ruleOverrideSet') expect(repos.setRuleOverride).toHaveBeenCalledExactlyOnceWith({ id: 'a1' }, 'r1', ruleBody);
      if (action === 'ruleOverrideClear') expect(repos.clearRuleOverride).toHaveBeenCalledExactlyOnceWith({ id: 'a1' }, 'r1');
      if (action === 'gitlabCredentials') expect(repos.rotateGitlabCredentials).toHaveBeenCalledExactlyOnceWith('r1', credentialsPatch);
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
