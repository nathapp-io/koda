import type { Mocked } from 'vitest';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { DASH_NOW, dashCaps, dashJob, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { PauseSnapshot } from '../budgets/budget-rules';
import type { BudgetGate } from '../budgets/budget-gate';
import { FleetDashboardService } from './dashboard.service';
import type { IDashboardRepository, RawRunnerRow } from './domain/dashboard.domain';

const rawRunner = (over: Partial<RawRunnerRow> = {}): RawRunnerRow => ({
  id: 'r1', name: 'wk-mac', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, lastSeenAt: secAgo(10), capacity: 1,
  daemonVersion: '0.4.0', capabilities: dashCaps(), ...over,
});

function fakeRepo(over: Partial<IDashboardRepository> = {}): Mocked<IDashboardRepository> {
  return {
    findRunners: vi.fn().mockResolvedValue([rawRunner(), rawRunner({ id: 'r2', name: 'corrupt', capabilities: { broken: true } })]),
    findHeldRefs: vi.fn().mockResolvedValue([{ runnerId: 'r1', repoId: 'repo1' }]),
    findActiveJobs: vi.fn().mockResolvedValue([dashJob({ lastHeartbeatAt: secAgo(700) })]),
    findQueuedWindow: vi.fn().mockResolvedValue([]),
    findRecentJobs: vi.fn().mockResolvedValue([]),
    countActiveByState: vi.fn().mockResolvedValue(new Map([['RUNNING', 1]])),
    pendingSummaryByJob: vi.fn().mockResolvedValue([]),
    ...over,
  } as Mocked<IDashboardRepository>;
}

const budgets = { snapshot: vi.fn().mockResolvedValue(PauseSnapshot.of([], DASH_NOW)) } as unknown as BudgetGate;

describe('FleetDashboardService (S2b (c) §1)', () => {
  it('reads with the caps and windows of the spec and tolerates a corrupt runner', async () => {
    const repo = fakeRepo();
    const service = new FleetDashboardService(repo, budgets, testFleetConfig());
    const v = await service.snapshot({ kind: 'project', projectId: 'p1' }, DASH_NOW);
    expect(repo.findActiveJobs).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 201);
    expect(repo.findQueuedWindow).toHaveBeenCalledWith(50);
    expect(repo.findRecentJobs).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, new Date(DASH_NOW.getTime() - 86_400_000), 21);
    expect(repo.pendingSummaryByJob).toHaveBeenCalledWith(['j1']);
    expect(v.attention.map((a) => [a.kind, a.severity])).toEqual([['job_silent', 'error']]);
    // Global scope shows versions, so a wrong readCapabilities would show here (project scope nulls them anyway).
    const g = await new FleetDashboardService(fakeRepo(), budgets, testFleetConfig()).snapshot({ kind: 'global' }, DASH_NOW);
    expect(g.runners.find((r) => r.id === 'r2')).toEqual(expect.objectContaining({ naxVersion: null, credentials: [], online: true }));
    expect(g.runners.find((r) => r.id === 'r1')?.naxVersion).toBe('0.83.3');
  });

  it('passes the credential expiry window to the attention rules (S3 §4.4)', async () => {
    const soon = new Date(DASH_NOW.getTime() + 10 * 86_400_000).toISOString();
    const caps = dashCaps({ credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false }] });
    const repo = fakeRepo({ findRunners: vi.fn().mockResolvedValue([rawRunner({ capabilities: caps })]), findActiveJobs: vi.fn().mockResolvedValue([]) });
    const v7 = await new FleetDashboardService(repo, budgets, testFleetConfig()).snapshot({ kind: 'global' }, DASH_NOW);
    expect(v7.attention).toEqual([]);
    const v14 = await new FleetDashboardService(repo, budgets, testFleetConfig({ credentialExpiryWarnDays: 14 })).snapshot({ kind: 'global' }, DASH_NOW);
    expect(v14.attention.map((a) => a.conditions)).toEqual([[{ type: 'credential', providerId: 'deepseek', why: 'expiring' }]]);
  });

  it('asks pending approvals only for the listed (capped) jobs', async () => {
    const many = Array.from({ length: 201 }, (_, i) => dashJob({ id: `j${i}` }));
    const repo = fakeRepo({ findActiveJobs: vi.fn().mockResolvedValue(many) });
    await new FleetDashboardService(repo, budgets, testFleetConfig()).snapshot({ kind: 'global' }, DASH_NOW);
    expect(repo.pendingSummaryByJob.mock.calls[0][0]).toHaveLength(200);
  });
});
