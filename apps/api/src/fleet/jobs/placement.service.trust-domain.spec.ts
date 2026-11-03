import { FleetJobState } from '../../common/enums';
import type { ActiveJobRef, PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

/**
 * US-004: both fill loops carry each job they assign into the load the next candidate is judged on, so a single
 * sync pass never places two different projects on one runner and still keeps same-project work together.
 * Drives the real service with fake collaborators, no database.
 */
const NOW = new Date('2026-11-02T12:00:00.000Z');
const OFFLINE_SEC = 90;

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 2, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 2,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
    credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
    tools: { git: true, gh: true, glab: true }, executors: ['host'], approvals: { relay: true },
    threadBackends: { native: ['m1'], acp: [] },
  },
  ...over,
} as PlacementRunnerRow);

interface QueuedJob {
  id: string;
  projectId: string;
  repoId: string;
  command: 'RUN' | 'THREAD';
}

const jobRecord = (job: QueuedJob) => ({
  id: job.id, projectId: job.projectId, repoId: job.repoId, command: job.command, state: FleetJobState.QUEUED,
  pinnedRunnerId: null, selectorLabels: [], profiles: ['fast'], bashMode: 'raw', threadId: job.command === 'THREAD' ? `t-${job.id}` : null,
  feature: `f-${job.id}`, ref: 'trunk', maxCostUsd: '5', planFrom: null, approvalTimeoutSec: 600, leaseEpoch: 0, runnerId: null,
});

const threadAssignOf = (job: QueuedJob) => ({
  threadId: `t-${job.id}`, action: 'SESSION', kind: 'REPO', feature: `f-${job.id}`, resume: false, instructions: 'go',
  backend: { kind: 'native', model: 'm1' }, skills: [], initialMessage: null,
});

/** One runner, the given QUEUED jobs (returned oldest first) and the jobs it already holds. */
function fixture(queued: QueuedJob[], held: ActiveJobRef[] = []) {
  const byId = new Map(queued.map((j) => [j.id, j]));
  const repos = new Map(queued.map((j) => [j.repoId, {
    id: j.repoId, projectId: j.projectId, provider: 'github' as const, owner: 'acme', name: `app-${j.repoId}`, defaultBranch: 'trunk', githubInstallationId: null,
  }]));
  const runners = [runnerRow()];
  const assigned: string[] = [];
  const repo = {
    findRepo: vi.fn(async (repoId: string) => repos.get(repoId) ?? null),
    lockById: vi.fn(async (id: string) => (byId.get(id) ? jobRecord(byId.get(id) as QueuedJob) : null)),
    findPlacementRunners: vi.fn(async () => runners),
    lockRunners: vi.fn(async () => runners.map((r) => r.id)),
    findActiveLoads: vi.fn(async () => held),
    findQueuedPage: vi.fn(async () => queued.map((j, i) => ({ id: j.id, queuedAt: new Date(NOW.getTime() + i * 1_000) }))),
    findThreadAssign: vi.fn(async (id: string) => (byId.get(id)?.command === 'THREAD' ? threadAssignOf(byId.get(id) as QueuedJob) : null)),
    findById: vi.fn(async (id: string) => jobRecord(byId.get(id) as QueuedJob)),
    createCommand: vi.fn(async (c: { type: string; payload: unknown }) => c),
    pinThreadRunner: vi.fn(async () => undefined),
    casAssign: vi.fn(async (jobId: string) => { assigned.push(jobId); return 1; }),
  };
  const service = new PlacementService(
    repo as never,
    { record: vi.fn(async () => ({ live: {} })) } as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) } as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { threadsEnabled: true, runnerOfflineSec: OFFLINE_SEC } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
    { record: vi.fn(async () => undefined) } as never,
  );
  return { service, assigned };
}

describe('US-004: fillRunner folds each assignment into the load of the same pass', () => {
  it('leaves the second project of one sync QUEUED when the first was just assigned', async () => {
    const { service, assigned } = fixture([
      { id: 'j1', projectId: 'p1', repoId: 'repo-a', command: 'RUN' },
      { id: 'j2', projectId: 'p2', repoId: 'repo-b', command: 'RUN' },
    ]);
    expect(await service.fillRunner('r1', 2, NOW)).toBe(1);
    expect(assigned).toEqual(['j1']);
  });

  it('still places two jobs of the same project on distinct repos in one pass', async () => {
    const { service, assigned } = fixture([
      { id: 'j1', projectId: 'p1', repoId: 'repo-a', command: 'RUN' },
      { id: 'j2', projectId: 'p1', repoId: 'repo-b', command: 'RUN' },
    ]);
    expect(await service.fillRunner('r1', 2, NOW)).toBe(2);
    expect(assigned).toEqual(['j1', 'j2']);
  });
});

describe('US-004: fillRunnerThreads folds each assignment into the load of the same pass', () => {
  it('leaves another project\'s thread QUEUED when the first turn was just assigned', async () => {
    const { service, assigned } = fixture([
      { id: 'j1', projectId: 'p1', repoId: 'repo-a', command: 'THREAD' },
      { id: 'j2', projectId: 'p2', repoId: 'repo-b', command: 'THREAD' },
    ]);
    await service.fillRunnerThreads('r1', NOW);
    expect(assigned).toEqual(['j1']);
  });

  it('still fills every free thread slot with one project\'s turns', async () => {
    const { service, assigned } = fixture([
      { id: 'j1', projectId: 'p1', repoId: 'repo-a', command: 'THREAD' },
      { id: 'j2', projectId: 'p1', repoId: 'repo-b', command: 'THREAD' },
    ]);
    await service.fillRunnerThreads('r1', NOW);
    expect(assigned).toEqual(['j1', 'j2']);
  });
});
