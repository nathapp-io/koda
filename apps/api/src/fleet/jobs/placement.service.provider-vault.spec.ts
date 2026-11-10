import { FleetCommandType, FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { providerScopeLookupKey, type ProviderLookupScope } from '../provider-credentials/provider-credential.domain';
import { PlacementService } from './placement.service';

/**
 * C10 (branch review B3): `providerVault` lets a runner skip a local credential refusal only for a provider
 * koda holds an applicable key for. The reproduction: two otherwise equivalent runners, one with the helper
 * and an empty credential list, one with the local credential — placement must pick the credentialed runner
 * unless the vault can actually serve the job, and the vault answer is read for the job's own scope.
 */
const NOW = new Date('2026-11-06T12:00:00.000Z');

const caps = (over: Record<string, unknown> = {}) => ({
  nax: { version: '0.91.7', protocols: ['native'] },
  sandbox: { available: true, probedAt: NOW.toISOString() },
  profiles: { fast: { protocol: 'native', providers: ['openrouter'], sandbox: false } },
  credentials: [],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
  ...over,
});

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r-local', name: 'local', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 4, bootId: 'boot-local', capabilities: caps({ credentials: [{ providerId: 'openrouter', available: true, stored: null, ambient: false }] }),
  ...over,
} as PlacementRunnerRow);

/** The vault runner sorts first (older lastSeenAt), so any wrong answer shows up as the wrong runner. */
const vaultRunner = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow =>
  runnerRow({ id: 'r-vault', name: 'vault', bootId: 'boot-vault', lastSeenAt: new Date(NOW.getTime() - 5_000), capabilities: caps({ providerVault: true }), ...over });

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1', projectId: 'p1', repoId: 'repo1', command: 'RUN', state: FleetJobState.QUEUED, pinnedRunnerId: null,
  selectorLabels: [], profiles: ['fast'], bashMode: 'raw', maxCostUsd: '5', leaseEpoch: 0,
  ...over,
});

/**
 * The vault's public service as placement sees it: one answer per requested scope, from `keys`.
 * `availableProviders` is a spy so a run that needs no vault answer is provably read-free.
 */
function credentials(keys: Record<string, string[]>) {
  const availableProviders = vi.fn(async (scopes: readonly ProviderLookupScope[]) => new Map(
    scopes.map((scope) => [providerScopeLookupKey(scope), new Set(keys[providerScopeLookupKey(scope)] ?? [])] as const),
  ));
  return { availableProviders };
}

const scope = { projectId: 'p1', repoId: 'repo1' };

function fixture(runners: PlacementRunnerRow[], keys: Record<string, string[]> = {}) {
  const record = job();
  const repo = {
    lockById: vi.fn(async () => record),
    findRepo: vi.fn(async () => ({ id: 'repo1', projectId: 'p1', provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: null })),
    findPlacementRunners: vi.fn(async () => runners),
    lockRunners: vi.fn(async () => runners.map((r) => r.id)),
    findActiveLoads: vi.fn(async () => []),
    findQueuedPage: vi.fn(async () => [{ id: record.id, queuedAt: NOW }]),
    findThreadAssign: vi.fn(async () => null),
    // US-008: a RUN job is a nax command, so placement reads the repo's rule override for it.
    findRuleOverride: vi.fn(async () => null),
    setRuleOverrideSummary: vi.fn(async () => undefined),
    createCommand: vi.fn(async (c: { type: FleetCommandType; payload: unknown }) => c),
    casAssign: vi.fn(async () => 1),
    findById: vi.fn(async () => record),
    pinThreadRunner: vi.fn(async () => undefined),
  };
  const vault = credentials(keys);
  const service = new PlacementService(
    repo as never,
    { record: vi.fn(async () => ({ live: {} })) } as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) } as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { threadsEnabled: true, runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
    { record: vi.fn(async () => undefined) } as never,
    vault as never,
  );
  return { service, repo, vault };
}

describe('C10 B3: placeJob judges a vault runner on the keys koda can actually hand it', () => {
  it('picks the locally credentialed runner when koda holds no applicable key', async () => {
    const { service, repo, vault } = fixture([vaultRunner(), runnerRow()]);

    const outcome = await service.placeJob('j1', NOW);

    expect(outcome.assigned).toBe(true);
    expect(outcome.runnerId).toBe('r-local');
    expect(outcome.misfits).toEqual([{ runnerId: 'r-vault', name: 'vault', reason: 'provider_missing' }]);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'r-local', type: FleetCommandType.ASSIGN }));
    expect(vault.availableProviders).toHaveBeenCalledWith([scope]);
  });

  it('places the vault runner once koda holds a key for the job scope', async () => {
    const { service } = fixture([vaultRunner(), runnerRow()], { [providerScopeLookupKey(scope)]: ['openrouter'] });

    const outcome = await service.placeJob('j1', NOW);

    expect(outcome).toMatchObject({ assigned: true, runnerId: 'r-vault', misfits: [] });
  });

  it('reads nothing when no candidate reports the helper', async () => {
    const { service, vault } = fixture([runnerRow()]);

    expect(await service.placeJob('j1', NOW)).toMatchObject({ assigned: true, runnerId: 'r-local' });
    expect(vault.availableProviders).not.toHaveBeenCalled();
  });

  it('leaves the job queued when the only vault runner cannot be served', async () => {
    const { service, repo } = fixture([vaultRunner()]);

    const outcome = await service.placeJob('j1', NOW);

    expect(outcome).toMatchObject({ assigned: false, misfits: [{ runnerId: 'r-vault', reason: 'provider_missing' }] });
    expect(repo.casAssign).not.toHaveBeenCalled();
  });

  it('judges the pin the same way at dispatch (evaluatePinned)', async () => {
    const { service } = fixture([vaultRunner()]);
    const placement = { command: 'RUN', repoId: 'repo1', projectId: 'p1', provider: 'github' as const, profiles: ['fast'], selectorLabels: [], pinnedRunnerId: 'r-vault', bashMode: 'raw' as const };

    await expect(service.evaluatePinned('r-vault', placement, NOW)).resolves.toBe('provider_missing');
    const served = fixture([vaultRunner()], { [providerScopeLookupKey(scope)]: ['openrouter'] });
    await expect(served.service.evaluatePinned('r-vault', placement, NOW)).resolves.toBeNull();
  });
});

describe('C10 B3: fillRunner (a runner sync) applies the same rule', () => {
  it('takes no job from a vault runner koda cannot serve', async () => {
    const { service, repo } = fixture([vaultRunner()]);

    expect(await service.fillRunner('r-vault', 1, NOW)).toBe(0);
    expect(repo.casAssign).not.toHaveBeenCalled();
  });

  it('takes the job once the vault holds the provider for that scope', async () => {
    const { service, repo } = fixture([vaultRunner()], { [providerScopeLookupKey(scope)]: ['openrouter'] });

    expect(await service.fillRunner('r-vault', 1, NOW)).toBe(1);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'r-vault', type: FleetCommandType.ASSIGN }));
  });

  it('asks the vault once per job scope in a pass', async () => {
    const { service, vault } = fixture([vaultRunner()], { [providerScopeLookupKey(scope)]: ['openrouter'] });

    await service.fillRunner('r-vault', 1, NOW);

    expect(vault.availableProviders).toHaveBeenCalledTimes(1);
  });
});
