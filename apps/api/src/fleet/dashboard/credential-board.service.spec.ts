import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { DASH_NOW, dashCaps, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { CredentialBoardService } from './credential-board.service';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const raw = (over: Partial<RawRunnerRow> = {}): RawRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: [], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

describe('CredentialBoardService (S3 §4.4)', () => {
  it('derives the board from every runner, re-validating capabilities and computing online on the server clock', async () => {
    const repo = { findRunners: vi.fn().mockResolvedValue([raw(), raw({ id: 'r2', name: 'old', lastSeenAt: secAgo(500), capabilities: { broken: true } })]) };
    const service = new CredentialBoardService(repo as unknown as IDashboardRepository, testFleetConfig({ credentialExpiryWarnDays: 5 }));
    const board = await service.board(DASH_NOW);
    expect(board.warnDays).toBe(5);
    expect(board.runners).toEqual([
      { id: 'r1', name: 'wk-mac', enabled: true, online: true, readable: true },
      { id: 'r2', name: 'old', enabled: true, online: false, readable: false },
    ]);
    expect(board.providers.map((p) => p.providerId)).toEqual(['deepseek']);
  });
});
