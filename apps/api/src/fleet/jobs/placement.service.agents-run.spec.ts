import { FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

/**
 * US-005 AC-13: an AGENT job is placed only on a runner that reports `agentsRun`. When no runner does, the job stays
 * QUEUED with the recoverable misfit `agents_run` named for every otherwise fitting runner — never assigned, and
 * never cancelled (a runner upgrade fixes it). Drives the real `placeJob` with fake collaborators (no database).
 */
const NOW = new Date('2026-11-05T12:00:00.000Z');

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 2, bootId: 'boot-1', protocolVersion: 4,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
    credentials: [{ providerId: 'deepseek', available: true, stored: null, ambient: false }],
    tools: { git: true, gh: true, glab: true }, executors: ['host'],
  },
  ...over,
} as PlacementRunnerRow);

const agentJob = (over: Record<string, unknown> = {}) => ({
  id: 'j1', projectId: 'p1', repoId: 'repo1', ref: 'main', command: 'AGENT', state: FleetJobState.QUEUED,
  feature: 'flow-a', profiles: ['fast'], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw',
  agentInput: { name: 'spec-reviewer', task: 'x' },
  ...over,
});

function fixture(runners: PlacementRunnerRow[], job = agentJob()) {
  const repo = {
    findRepo: vi.fn(async () => ({ id: 'repo1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: null })),
    lockById: vi.fn(async () => job),
    findPlacementRunners: vi.fn(async () => runners),
    lockRunners: vi.fn(async () => runners.map((r) => r.id)),
    findActiveLoads: vi.fn(async () => []),
    findThreadAssign: vi.fn(async () => null),
    // US-008: an AGENT job is a nax command, so placement reads the repo's rule override for it.
    findRuleOverride: vi.fn(async () => null),
    setRuleOverrideSummary: vi.fn(async () => undefined),
    createCommand: vi.fn(async () => ({})),
    casAssign: vi.fn(async () => 1),
    findById: vi.fn(async () => job),
  };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const budgets = { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) };
  const transitions = { record: vi.fn(async () => ({ type: 'fleet_job', jobId: job.id })), apply: vi.fn() };
  const service = new PlacementService(
    repo as never,
    transitions as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    budgets as never,
    txManager as never,
    { threadsEnabled: false, runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
    {} as never,
    { availableProviders: vi.fn(async () => new Map()) } as never,
  );
  return { service, repo };
}

describe('US-005 AC-13: an AGENT job waits for a runner that reports agentsRun', () => {
  it('leaves the job QUEUED and names agents_run for every otherwise fitting runner', async () => {
    const { service, repo } = fixture([runnerRow({ id: 'r1', name: 'box-1' }), runnerRow({ id: 'r2', name: 'box-2' })]);
    const outcome = await service.placeJob('j1', NOW);
    expect(outcome.assigned).toBe(false);
    expect(outcome.runnerId).toBeNull();
    expect(outcome.misfits).toEqual([
      { runnerId: 'r1', name: 'box-1', reason: 'agents_run' },
      { runnerId: 'r2', name: 'box-2', reason: 'agents_run' },
    ]);
    expect(repo.casAssign).not.toHaveBeenCalled();
    expect(repo.createCommand).not.toHaveBeenCalled();
  });

  it('assigns the same job once a candidate reports agentsRun', async () => {
    const { service, repo } = fixture([
      runnerRow({ id: 'r1', name: 'box-1' }),
      runnerRow({ id: 'r2', name: 'box-2', capabilities: { ...runnerRow().capabilities, agentsRun: true } }),
    ]);
    const outcome = await service.placeJob('j1', NOW);
    expect(outcome).toMatchObject({ assigned: true, runnerId: 'r2' });
    expect(repo.casAssign).toHaveBeenCalledTimes(1);
    expect(outcome.misfits).toEqual([{ runnerId: 'r1', name: 'box-1', reason: 'agents_run' }]);
    // The ASSIGN carries the agent block and no review block (AC-4).
    const payload = repo.createCommand.mock.calls[0][0].payload as { agent?: unknown; review?: unknown };
    expect(payload.agent).toEqual({ name: 'spec-reviewer', task: 'x' });
    expect(payload).not.toHaveProperty('review');
  });
});
