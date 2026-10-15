import { FleetCommandType, FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

/**
 * US-005: both placement entry points carry the normalized thread kind, so a PROJECT thread is hosted only by a runner
 * that advertises `projectThreads` (S5b-R9). `placeJob` runs right after a send commits; `fillRunnerThreads` runs from
 * a runner sync. Drives the real service with fake collaborators, no database.
 */
const NOW = new Date('2026-10-16T12:00:00.000Z');

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

const withProjectThreads = (runner: PlacementRunnerRow): PlacementRunnerRow =>
  ({ ...runner, capabilities: { ...runner.capabilities, projectThreads: true } });

/** Fake collaborators for one QUEUED THREAD job whose turn names `kind`. */
function fixture(kind: 'REPO' | 'PROJECT') {
  const job = {
    id: 'j1', projectId: 'p1', repoId: 'repo1', command: 'THREAD', state: FleetJobState.QUEUED, pinnedRunnerId: null,
    selectorLabels: [], profiles: [], bashMode: 'raw', threadId: 't1', feature: `thread-t1`, ref: 'trunk', maxCostUsd: '5',
    planFrom: null, approvalTimeoutSec: 600, leaseEpoch: 0,
  };
  const threadAssign = {
    threadId: 't1', action: 'SESSION', kind, feature: kind === 'PROJECT' ? 'thread-t1' : 'auth', resume: false,
    instructions: 'go', backend: { kind: 'native', model: 'm1' }, skills: [], initialMessage: null,
  };
  const repo = {
    findRepo: vi.fn(async () => ({ id: 'repo1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: null })),
    lockById: vi.fn(async () => job),
    findPlacementRunners: vi.fn(async () => runners),
    lockRunners: vi.fn(async () => runners.map((r) => r.id)),
    findActiveLoads: vi.fn(async () => []),
    findQueuedIds: vi.fn(async () => ['j1']),
    findThreadAssign: vi.fn(async () => threadAssign),
    createCommand: vi.fn(async (c: { type: FleetCommandType; payload: unknown }) => c),
    casAssign: vi.fn(async () => 1),
    findById: vi.fn(async () => job),
    pinThreadRunner: vi.fn(async () => undefined),
  };
  const transitions = { record: vi.fn(async () => ({ live: {} })) };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const budgets = { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) };
  const service = new PlacementService(
    repo as never,
    transitions as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    budgets as never,
    txManager as never,
    { threadsEnabled: true, runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
  );
  let runners: PlacementRunnerRow[] = [runnerRow()];
  return { service, repo, setRunners: (rows: PlacementRunnerRow[]) => { runners = rows; } };
}

describe('US-005: placeJob carries the thread kind into placement', () => {
  it('AC-6: leaves a PROJECT THREAD job QUEUED on a runner without projectThreads', async () => {
    const { service, repo } = fixture('PROJECT');
    const outcome = await service.placeJob('j1', NOW);
    expect(outcome.assigned).toBe(false);
    expect(outcome.misfits).toEqual([{ runnerId: 'r1', name: 'box-1', reason: 'project_threads' }]);
    expect(repo.casAssign).not.toHaveBeenCalled();
    expect(repo.createCommand).not.toHaveBeenCalled();
  });

  it('assigns a PROJECT THREAD job to a runner advertising projectThreads', async () => {
    const { service, repo, setRunners } = fixture('PROJECT');
    setRunners([withProjectThreads(runnerRow())]);
    const outcome = await service.placeJob('j1', NOW);
    expect(outcome).toMatchObject({ assigned: true, runnerId: 'r1' });
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({
      runnerId: 'r1', type: FleetCommandType.ASSIGN, payload: expect.objectContaining({ thread: expect.objectContaining({ kind: 'PROJECT' }) }),
    }));
  });

  it('AC-10: still places a REPO THREAD job on a runner without projectThreads', async () => {
    const { service, repo } = fixture('REPO');
    const outcome = await service.placeJob('j1', NOW);
    expect(outcome.assigned).toBe(true);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: FleetCommandType.ASSIGN, payload: expect.objectContaining({ thread: expect.objectContaining({ kind: 'REPO' }) }),
    }));
  });
});

describe('US-005: fillRunnerThreads (a runner sync) carries the thread kind into placement', () => {
  it('AC-7: queues no ASSIGN for a PROJECT THREAD job on a runner without projectThreads', async () => {
    const { service, repo } = fixture('PROJECT');
    await service.fillRunnerThreads('r1', NOW);
    expect(repo.findQueuedIds).toHaveBeenCalled();
    expect(repo.casAssign).not.toHaveBeenCalled();
    expect(repo.createCommand).not.toHaveBeenCalled();
  });

  it('assigns a PROJECT THREAD job to a syncing runner advertising projectThreads', async () => {
    const { service, repo, setRunners } = fixture('PROJECT');
    setRunners([withProjectThreads(runnerRow())]);
    await service.fillRunnerThreads('r1', NOW);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({
      runnerId: 'r1', type: FleetCommandType.ASSIGN, payload: expect.objectContaining({ thread: expect.objectContaining({ kind: 'PROJECT' }) }),
    }));
  });

  it('AC-10: still assigns a REPO THREAD job to a syncing runner without projectThreads', async () => {
    const { service, repo } = fixture('REPO');
    await service.fillRunnerThreads('r1', NOW);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: FleetCommandType.ASSIGN, payload: expect.objectContaining({ thread: expect.objectContaining({ kind: 'REPO' }) }),
    }));
  });
});
