import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { DASH_NOW, dashCaps, secAgo } from '../../common/test-helpers/fleet-dashboard';
import type { ProviderKeySummary } from '../provider-credentials/provider-credential.domain';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import { CredentialBoardService } from './credential-board.service';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const raw = (over: Partial<RawRunnerRow> = {}): RawRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

const kodaKey = (over: Partial<ProviderKeySummary> = {}): ProviderKeySummary => ({
  providerId: 'openrouter', name: 'fleet', last4: '3456', updatedAt: DASH_NOW.toISOString(), ...over,
});

/** The board only needs the one projection; the write methods stay out of this spec's way. */
const credentials = (keys: ProviderKeySummary[] = []) =>
  ({ listActiveGlobalKeys: vi.fn().mockResolvedValue(keys) }) as unknown as ProviderCredentialsService;

describe('CredentialBoardService (S3 §4.4)', () => {
  it('derives the board from every runner, re-validating capabilities and computing online on the server clock', async () => {
    const repo = { findRunners: vi.fn().mockResolvedValue([raw(), raw({ id: 'r2', name: 'old', lastSeenAt: secAgo(500), capabilities: { broken: true } })]) };
    const service = new CredentialBoardService(
      repo as unknown as IDashboardRepository,
      testFleetConfig({ credentialExpiryWarnDays: 5 }),
      credentials(),
    );
    const board = await service.board(DASH_NOW);
    expect(board.warnDays).toBe(5);
    expect(board.runners).toEqual([
      { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true, providerVault: false },
      { id: 'r2', name: 'old', enabled: true, online: false, readable: false, providerVault: false },
    ]);
    expect(board.providers.map((p) => p.providerId)).toEqual(['deepseek']);
  });

  it('AC-5/AC-8 (C10 US-007): carries the vault service koda keys and adds their providers to the inventory', async () => {
    const repo = { findRunners: vi.fn().mockResolvedValue([raw({ capabilities: dashCaps({ providerVault: true }) })]) };
    const vault = credentials([kodaKey()]);
    const service = new CredentialBoardService(repo as unknown as IDashboardRepository, testFleetConfig(), vault);

    const board = await service.board(DASH_NOW);

    expect(vault.listActiveGlobalKeys).toHaveBeenCalledExactlyOnceWith();
    expect(board.kodaKeys).toEqual([kodaKey()]);
    expect(board.runners[0].providerVault).toBe(true);
    expect(board.providers.map((p) => p.providerId)).toEqual(['deepseek', 'openrouter']);
  });

  it('answers no koda rows when the vault has none (the vault is off, or no active GLOBAL key exists)', async () => {
    const repo = { findRunners: vi.fn().mockResolvedValue([]) };
    const service = new CredentialBoardService(repo as unknown as IDashboardRepository, testFleetConfig(), credentials());

    const board = await service.board(DASH_NOW);

    expect(board.kodaKeys).toEqual([]);
    expect(board.providers).toEqual([]);
  });
});
