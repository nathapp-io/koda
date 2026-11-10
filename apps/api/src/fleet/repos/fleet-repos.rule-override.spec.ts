import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { FleetRepoRecord } from './domain/fleet-repo.domain';
import { FleetRepoRouteCommands, FLEET_REPO_ROUTE_VARIANTS } from './fleet-repo-route.commands';
import { FleetReposService } from './fleet-repos.service';
import { validateRuleOverride } from './rule-override';

/**
 * US-007: the per-repo rule override storage (#370).
 *
 * The override is a repo's own rule files and context, stored under one global key and audited as
 * a repo write. These are the service-level facts the route cannot prove on its own: the audit
 * entry a set and a clear leave behind, and the fact that a clear of a repo with no override
 * leaves none.
 */
describe('FleetReposService rule override', () => {
  const row = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'repo', defaultBranch: 'main',
    githubInstallationId: 1n, createdById: 'u0', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  /** The stored override the mocked repository keeps between the calls of one test. */
  let stored: {
    repoId: string;
    rules: { path: string; content: string }[];
    rulesMode: 'merge' | 'replace';
    context: { content: string; mode: 'append' | 'replace' } | null;
    sha256: string;
    ruleFiles: number;
    updatedAt: Date;
  } | null = null;

  let repo: {
    findById: ReturnType<typeof vi.fn>;
    findRuleOverride: ReturnType<typeof vi.fn>;
    upsertRuleOverride: ReturnType<typeof vi.fn>;
    deleteRuleOverride: ReturnType<typeof vi.fn>;
  };
  let tx: { run: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let permissions: { canHoldKey: ReturnType<typeof vi.fn> };

  const service = () => new FleetReposService(
    repo as never, {} as never, {} as never, {} as never, {} as never, tx as never,
    audit as never, permissions as never,
  );
  const principal = (actorType: 'user' | 'agent' = 'user') =>
    ({ actorType, id: actorType === 'user' ? 'u1' : 'a1' }) as never;

  const body = {
    rules: [{ path: 'api.md', content: 'answer with the summary' }, { path: 'ci.md', content: 'run the checks' }],
    rulesMode: 'merge',
    context: { content: 'the project answers in english', mode: 'append' },
  };

  beforeEach(() => {
    stored = null;
    repo = {
      findById: vi.fn().mockImplementation(async () => ({
        ...row(),
        ruleOverride: stored === null ? null : {
          sha256: stored.sha256,
          ruleFiles: stored.ruleFiles,
          rulesMode: stored.rulesMode,
          contextMode: stored.context?.mode ?? null,
          updatedAt: stored.updatedAt,
        },
      })),
      findRuleOverride: vi.fn().mockImplementation(async () => stored),
      upsertRuleOverride: vi.fn().mockImplementation(async (repoId: string, input: never, sha256: string) => {
        const validated = input as { rules: { path: string; content: string }[]; rulesMode: 'merge' | 'replace'; context: { content: string; mode: 'append' | 'replace' } | null };
        stored = {
          repoId, rules: validated.rules, rulesMode: validated.rulesMode, context: validated.context,
          sha256, ruleFiles: validated.rules.length, updatedAt: new Date(0),
        };
        return stored;
      }),
      deleteRuleOverride: vi.fn().mockImplementation(async () => {
        const existed = stored !== null;
        stored = null;
        return existed;
      }),
    };
    tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    audit = { record: vi.fn() };
    permissions = { canHoldKey: vi.fn().mockResolvedValue(true) };
  });

  it('AC-10: a set records one audit entry with the rules key, the repo resource and the file-count summary', async () => {
    const result = await service().setRuleOverride(principal(), 'r1', body);

    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.repo.rules.configure', resourceType: 'fleet-repo', resourceId: 'r1',
      projectId: 'p1', summary: 'rule override set (2 files, merge)',
    });
    // The answer is the repo with its override summary, so the caller sees what it stored.
    expect(result).toMatchObject({ id: 'r1', ruleOverride: { ruleFiles: 2, rulesMode: 'merge', contextMode: 'append' } });
  });

  it('AC-10: the set stores the validated input and the hash it computed', async () => {
    await service().setRuleOverride(principal(), 'r1', body);

    expect(repo.upsertRuleOverride).toHaveBeenCalledExactlyOnceWith(
      'r1',
      validateRuleOverride(body),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      { id: 'u1', type: 'USER' },
    );
  });

  it('AC-11: a clear of a repo with an override records one audit entry with the cleared summary', async () => {
    await service().setRuleOverride(principal(), 'r1', body);
    audit.record.mockClear();

    const result = await service().clearRuleOverride(principal(), 'r1');

    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.repo.rules.configure', resourceType: 'fleet-repo', resourceId: 'r1',
      projectId: 'p1', summary: 'rule override cleared',
    });
    expect(result).toMatchObject({ id: 'r1', ruleOverride: null });
  });

  it('AC-12: a clear of a repo with no override records no audit entry', async () => {
    const result = await service().clearRuleOverride(principal(), 'r1');

    expect(audit.record).not.toHaveBeenCalled();
    expect(repo.deleteRuleOverride).toHaveBeenCalledExactlyOnceWith('r1');
    expect(result).toMatchObject({ id: 'r1', ruleOverride: null });
  });

  it('404s an unknown repo on a set and a clear, and writes nothing', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service().setRuleOverride(principal(), 'r1', body)).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(service().setRuleOverride(principal(), 'r1', body)).rejects.toMatchObject({ prefix: 'fleet.repos' });
    await expect(service().clearRuleOverride(principal(), 'r1')).rejects.toMatchObject({ prefix: 'fleet.repos' });
    expect(repo.upsertRuleOverride).not.toHaveBeenCalled();
    expect(repo.deleteRuleOverride).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('AC-9: refuses an unknown repo before an approval request could be opened for it', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service().assertRepoExists('r1')).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(service().assertRepoExists('r1')).rejects.toMatchObject({ prefix: 'fleet.repos' });
  });

  it('reads the full override of a repo, or null when it has none', async () => {
    await service().setRuleOverride(principal(), 'r1', body);

    const read = await service().getRuleOverride('r1');
    expect(read).toMatchObject({
      rules: body.rules, rulesMode: 'merge', context: body.context,
    });
    expect(read?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read?.updatedAt).toEqual(expect.any(String));

    stored = null;
    expect(await service().getRuleOverride('r1')).toBeNull();
  });
});

describe('FleetRepoRouteCommands rule override variants (US-007)', () => {
  const body = { rules: [{ path: 'api.md', content: 'answer with the summary' }], rulesMode: 'merge' };

  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'r1', ruleOverride: null };
    const repos = {
      setRuleOverride: vi.fn().mockResolvedValue(result),
      clearRuleOverride: vi.fn().mockResolvedValue(result),
    };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1', actorType: 'agent' }) };
    new FleetRepoRouteCommands(registry, repos as unknown as FleetReposService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, repos, loader, result };
  }

  it('AC-13: registers the rule-override set command under the rules key and the set variant', async () => {
    const { registry, repos, loader } = build();
    const command = registry.get('fleet.repo.rules.configure', FLEET_REPO_ROUTE_VARIANTS.ruleOverrideSet);
    if (!command) throw new Error('Missing route command');

    expect(FLEET_REPO_ROUTE_VARIANTS.ruleOverrideSet).toBe('rest:fleet-repos.rule-override.set');
    expect(command.parse({ id: 'r1', body })).toEqual({ id: 'r1', body });
    // The parse accepts its own output, so an approved request re-parses the frozen input.
    expect(command.parse({ id: 'r1', body })).toEqual({ id: 'r1', body });

    await command.execute({ id: 'r1', body });
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(repos.setRuleOverride).toHaveBeenCalledExactlyOnceWith({ id: 'a1', actorType: 'agent' }, 'r1', body);
  });

  it('AC-14: registers the rule-override clear command under the rules key and the clear variant', async () => {
    const { registry, repos } = build();
    const command = registry.get('fleet.repo.rules.configure', FLEET_REPO_ROUTE_VARIANTS.ruleOverrideClear);
    if (!command) throw new Error('Missing route command');

    expect(FLEET_REPO_ROUTE_VARIANTS.ruleOverrideClear).toBe('rest:fleet-repos.rule-override.clear');
    expect(command.parse({ id: 'r1' })).toEqual({ id: 'r1' });

    await command.execute({ id: 'r1' });
    expect(repos.clearRuleOverride).toHaveBeenCalledExactlyOnceWith({ id: 'a1', actorType: 'agent' }, 'r1');
  });

  it('refuses an input without an id, and a set without a body', () => {
    const { registry } = build();
    const set = registry.get('fleet.repo.rules.configure', FLEET_REPO_ROUTE_VARIANTS.ruleOverrideSet);
    const clear = registry.get('fleet.repo.rules.configure', FLEET_REPO_ROUTE_VARIANTS.ruleOverrideClear);
    for (const command of [set, clear]) {
      expect(() => command?.parse({})).toThrow();
      expect(() => command?.parse({ id: '' })).toThrow();
      expect(() => command?.parse(null)).toThrow();
    }
    // The set needs a body it can validate; the clear needs no body at all.
    expect(() => set?.parse({ id: 'r1' })).toThrow();
    expect(clear?.parse({ id: 'r1' })).toEqual({ id: 'r1' });
  });
});
