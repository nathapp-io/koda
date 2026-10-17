import { FleetCommandType, FleetJobState } from '../../common/enums';
import type { FleetRepoRef, PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

/**
 * US-003 (1c-b-D7): placement lists the project's repositories in a PROJECT SESSION ASSIGN, but only for a runner that
 * advertises `projectCode` — a runner without it must never read the repository list (1c-b-D7). Drives the real
 * placement entry points with fake collaborators, no database.
 */
const NOW = new Date('2026-10-18T12:00:00.000Z');

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 1, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 2,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'],
    threadBackends: { native: ['m1'], acp: [] },
    threadWrite: true,
    projectThreads: true,
  },
  ...over,
} as PlacementRunnerRow);

/** A runner that can host a PROJECT thread and read project code (1c-b-D1). */
const withProjectCode = (runner: PlacementRunnerRow): PlacementRunnerRow =>
  ({ ...runner, capabilities: { ...runner.capabilities, projectCode: true } });

const projectRepo = (over: Partial<FleetRepoRef> = {}): FleetRepoRef => ({
  id: 'ra', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk',
  githubInstallationId: 7n, ...over,
});

const threadAssign = (kind: 'REPO' | 'PROJECT' | 'WORKSPACE') => ({
  threadId: 't1', action: 'SESSION' as const, kind, feature: 'thread-t1', resume: false, instructions: 'go',
  backend: { kind: 'native', model: 'm1' }, skills: [], initialMessage: null,
});

function fixture(kind: 'REPO' | 'PROJECT' | 'WORKSPACE', runners: PlacementRunnerRow[], repos: FleetRepoRef[] = [projectRepo()]) {
  const job = {
    id: 'j1', projectId: 'p1', repoId: 'repo1', command: 'THREAD', state: FleetJobState.QUEUED, pinnedRunnerId: null,
    selectorLabels: [], profiles: [], bashMode: 'raw', threadId: 't1', feature: 'thread-t1', ref: 'trunk',
    maxCostUsd: '5', planFrom: null, approvalTimeoutSec: 600, leaseEpoch: 0,
  };
  const repo = {
    findRepo: vi.fn(async () => ({ id: 'repo1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: null })),
    lockById: vi.fn(async () => job),
    findPlacementRunners: vi.fn(async () => runners),
    lockRunners: vi.fn(async () => runners.map((r) => r.id)),
    findActiveLoads: vi.fn(async () => []),
    findQueuedIds: vi.fn(async () => ['j1']),
    findThreadAssign: vi.fn(async () => threadAssign(kind)),
    findProjectRepos: vi.fn(async () => repos),
    createCommand: vi.fn(async () => ({})),
    casAssign: vi.fn(async () => 1),
    findById: vi.fn(async () => job),
    pinThreadRunner: vi.fn(async () => undefined),
  };
  const service = new PlacementService(
    repo as never,
    { record: vi.fn(async () => ({ live: {} })) } as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) } as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { threadsEnabled: true, runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
  );
  /** The thread block of the one ASSIGN command the service queued. */
  const assignThread = (): Record<string, unknown> => {
    const call = repo.createCommand.mock.calls.find(([c]: [{ type: FleetCommandType }]) => c.type === FleetCommandType.ASSIGN);
    expect(call).toBeDefined();
    return ((call as unknown as [{ payload: { thread: Record<string, unknown> } }])[0].payload.thread);
  };
  return { service, repo, assignThread };
}

describe('US-003 AC-6: a PROJECT SESSION on a projectCode runner carries the project repositories', () => {
  it('reads the job project and lists its installed GitHub repositories', async () => {
    const repos = [
      projectRepo({ id: 'ra', owner: 'acme', name: 'app', defaultBranch: 'trunk' }),
      projectRepo({ id: 'rb', provider: 'gitlab', owner: 'acme', name: 'gl', githubInstallationId: null }),
    ];
    const { service, repo, assignThread } = fixture('PROJECT', [withProjectCode(runnerRow())], repos);

    const outcome = await service.placeJob('j1', NOW);

    expect(outcome).toMatchObject({ assigned: true, runnerId: 'r1' });
    expect(repo.findProjectRepos).toHaveBeenCalledWith('p1');
    expect(assignThread().projectRepos).toEqual([
      { repoId: 'ra', owner: 'acme', name: 'app', defaultBranch: 'trunk', cloneUrl: 'https://github.com/acme/app.git' },
    ]);
  });

  it('carries the unavailable entries beside the fetchable ones', async () => {
    const repos = [
      projectRepo({ id: 'ra', owner: 'acme', name: 'app' }),
      projectRepo({ id: 'rb', provider: 'gitlab', owner: 'acme', name: 'gl', githubInstallationId: null }),
      projectRepo({ id: 'rc', owner: 'acme', name: 'stale', githubInstallationId: null }),
    ];
    const { service, assignThread } = fixture('PROJECT', [withProjectCode(runnerRow())], repos);

    await service.placeJob('j1', NOW);

    expect(assignThread().projectReposUnavailable).toEqual([
      { owner: 'acme', name: 'gl', reason: 'not a GitHub repository' },
      { owner: 'acme', name: 'stale', reason: 'no installation' },
    ]);
  });

  it('still carries the koda tools descriptors and the thread block (1c-b-D3)', async () => {
    const { service, assignThread } = fixture('PROJECT', [withProjectCode({ ...runnerRow(), capabilities: { ...runnerRow().capabilities, kodaTools: true } } as PlacementRunnerRow)]);

    await service.placeJob('j1', NOW);

    expect(assignThread()).toMatchObject({ threadId: 't1', kind: 'PROJECT', instructions: 'go' });
    expect(assignThread().kodaTools).toBeDefined();
  });

  it('does the same through fillRunnerThreads (the runner sync path)', async () => {
    const { service, repo, assignThread } = fixture('PROJECT', [withProjectCode(runnerRow())]);

    await service.fillRunnerThreads('r1', NOW);

    expect(repo.findProjectRepos).toHaveBeenCalledWith('p1');
    expect(assignThread().projectRepos).toHaveLength(1);
  });
});

describe('US-003 AC-7, AC-8: no repository list without the capability or off a REPO thread', () => {
  it('AC-7: leaves projectRepos out for a PROJECT SESSION on a runner without projectCode, and never reads the repos', async () => {
    const { service, repo, assignThread } = fixture('PROJECT', [runnerRow()]);

    const outcome = await service.placeJob('j1', NOW);

    expect(outcome).toMatchObject({ assigned: true, runnerId: 'r1' });
    expect(assignThread()).not.toHaveProperty('projectRepos');
    expect(assignThread()).not.toHaveProperty('projectReposUnavailable');
    expect(repo.findProjectRepos).not.toHaveBeenCalled();
  });

  it('AC-8: leaves projectRepos out for a REPO SESSION on a runner with projectCode, and never reads the repos', async () => {
    const { service, repo, assignThread } = fixture('REPO', [withProjectCode(runnerRow())]);

    const outcome = await service.placeJob('j1', NOW);

    expect(outcome).toMatchObject({ assigned: true, runnerId: 'r1' });
    expect(assignThread()).toMatchObject({ kind: 'REPO' });
    expect(assignThread()).not.toHaveProperty('projectRepos');
    expect(repo.findProjectRepos).not.toHaveBeenCalled();
  });

  it('AC-7: never reads the repos for a PROJECT SESSION placed by fillRunnerThreads either', async () => {
    const { service, repo, assignThread } = fixture('PROJECT', [runnerRow()]);

    await service.fillRunnerThreads('r1', NOW);

    expect(assignThread()).not.toHaveProperty('projectRepos');
    expect(repo.findProjectRepos).not.toHaveBeenCalled();
  });
});


describe('workspace ASSIGN AC-6', () => {
  it('leaves a workspace job queued on a project-only runner (AC-4/10)', async () => {
    const { service, repo } = fixture('WORKSPACE', [runnerRow()]);
    const result = await service.placeJob('j1', NOW);
    expect(result).toMatchObject({ assigned: false, misfits: [{ runnerId: 'r1', reason: 'workspace_threads' }] });
    expect(repo.casAssign).not.toHaveBeenCalled();
    expect(repo.createCommand).not.toHaveBeenCalled();
    expect(await repo.findById()).toMatchObject({ state: FleetJobState.QUEUED });
  });
  it.each(['placeJob', 'fillRunnerThreads'] as const)('omits tools and project repos via %s', async (entry) => {
    const runner = runnerRow();
    runner.capabilities = { ...runner.capabilities, workspaceThreads: true, projectCode: true, kodaTools: true };
    const { service, repo, assignThread } = fixture('WORKSPACE', [runner]);
    await service[entry](entry === 'placeJob' ? 'j1' : 'r1', NOW);
    expect(assignThread()).toMatchObject({ kind: 'WORKSPACE' });
    expect(assignThread()).not.toHaveProperty('kodaTools');
    expect(assignThread()).not.toHaveProperty('projectRepos');
    expect(repo.findProjectRepos).not.toHaveBeenCalled();
  });
});
