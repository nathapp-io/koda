import { FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

/**
 * US-001 AC-12: placeJob on a queued THREAD job whose turn is PUBLISH, pinned to a runner without threadWrite,
 * reports that runner as `thread_write`. Drives the real placeJob with fake collaborators (no database).
 */
const NOW = new Date('2026-10-15T12:00:00.000Z');

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 1, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 2,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'],
    threadBackends: { native: ['m1'], acp: [] },
  },
  ...over,
} as PlacementRunnerRow);

function fixture(runner: PlacementRunnerRow, action: 'SESSION' | 'PUBLISH' | 'DISCARD') {
  const job = {
    id: 'j1', projectId: 'p1', repoId: 'repo1', command: 'THREAD', state: FleetJobState.QUEUED, pinnedRunnerId: runner.id,
    selectorLabels: [], profiles: [], bashMode: 'raw', threadId: 't1',
  };
  const repo = {
    findRepo: vi.fn(async () => ({ id: 'repo1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: null })),
    lockById: vi.fn(async () => job),
    findPlacementRunners: vi.fn(async () => [runner]),
    lockRunners: vi.fn(async () => [runner.id]),
    findActiveLoads: vi.fn(async () => []),
    findThreadAssign: vi.fn(async () => ({
      threadId: 't1', action, feature: 'auth', resume: false, instructions: 'go', backend: { kind: 'native', model: 'm1' },
      skills: [], initialMessage: null,
    })),
    createCommand: vi.fn(async () => ({})),
    casAssign: vi.fn(async () => 1),
    findById: vi.fn(async () => job),
    pinThreadRunner: vi.fn(async () => undefined),
  };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const budgets = { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) };
  const service = new PlacementService(
    repo as never,
    {} as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    budgets as never,
    txManager as never,
    { threadsEnabled: true, runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
  );
  return { service, repo };
}

describe('US-001 AC-12: placeJob reports a PUBLISH job on a runner without threadWrite as thread_write', () => {
  it('returns misfits mapping the pinned runner to thread_write and does not assign it', async () => {
    const { service, repo } = fixture(runnerRow(), 'PUBLISH');
    const outcome = await service.placeJob('j1', NOW);
    expect(outcome.assigned).toBe(false);
    expect(outcome.misfits).toEqual([{ runnerId: 'r1', name: 'box-1', reason: 'thread_write' }]);
    expect(repo.casAssign).not.toHaveBeenCalled();
  });
});
