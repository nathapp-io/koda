import { FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const runner = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 2, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 2,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'],
    threadBackends: { native: ['m1'], acp: [] },
  },
  ...over,
} as PlacementRunnerRow);

function fixture(options: { state?: string; ageSec?: number; pinnedRunnerId?: string | null; candidates?: PlacementRunnerRow[] } = {}) {
  const queuedAt = new Date(NOW.getTime() - (options.ageSec ?? 120) * 1_000);
  const job = {
    id: 'j1', projectId: 'p1', repoId: 'repo1', command: 'THREAD', state: options.state ?? FleetJobState.QUEUED,
    pinnedRunnerId: options.pinnedRunnerId ?? null, queuedAt, selectorLabels: [], profiles: [], bashMode: 'raw', threadId: 't1',
  };
  const repo = {
    findById: vi.fn(async () => job), findRepo: vi.fn(async () => ({ id: 'repo1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: null })),
    findPlacementRunners: vi.fn(async (ids?: readonly string[]) => options.candidates ?? (ids ? [runner()] : [runner()])),
    findActiveLoads: vi.fn(async () => []),
    findThreadAssign: vi.fn(async () => ({ threadId: 't1', action: 'SESSION', kind: 'REPO', mode: 'read', feature: 'auth', resume: false, instructions: 'go', backend: { kind: 'native', model: 'm2' }, skills: [], initialMessage: null })),
  };
  const budgets = { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) };
  const service = new PlacementService(
    repo as never, {} as never, {} as never, {} as never, budgets as never, {} as never,
    { threadsEnabled: true, runnerOfflineSec: 90 } as never, {} as never, {} as never, {} as never, {} as never,
  );
  return { service, repo, budgets, job };
}

describe('PlacementService.queuedVerdict', () => {
  it('returns null when the job is not QUEUED', async () => {
    const { service, repo } = fixture({ state: FleetJobState.RUNNING });
    expect(await service.queuedVerdict('j1', NOW, 60)).toBeNull();
    expect(repo.findRepo).not.toHaveBeenCalled();
  });

  it('returns null when the job has not exceeded the warning age', async () => {
    const { service } = fixture({ ageSec: 30 });
    expect(await service.queuedVerdict('j1', NOW, 60)).toBeNull();
  });

  it('judges a queued THREAD turn and returns its backend misfit', async () => {
    const { service } = fixture();
    await expect(service.queuedVerdict('j1', NOW, 60)).resolves.toEqual({
      jobId: 'j1', queuedAt: new Date(NOW.getTime() - 120_000), verdict: 'no_fit',
      reasons: [{ runnerName: 'box-1', reason: 'thread_backend' }],
    });
  });

  it('limits the candidate lookup to the pinned runner', async () => {
    const { service, repo } = fixture({ pinnedRunnerId: 'r1' });
    await service.queuedVerdict('j1', NOW, 60);
    expect(repo.findPlacementRunners).toHaveBeenCalledWith(['r1']);
  });

  it('returns null when at least one candidate fits', async () => {
    const fitting = runner({ capabilities: { ...runner().capabilities, threadBackends: { native: ['m2'], acp: [] } } });
    const { service } = fixture({ candidates: [fitting] });
    expect(await service.queuedVerdict('j1', NOW, 60)).toBeNull();
  });
});
