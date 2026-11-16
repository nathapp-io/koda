import { FleetCommandType, FleetJobState } from '../../common/enums';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';

const NOW = new Date('2026-11-17T12:00:00.000Z');

const runner: PlacementRunnerRow = {
  id: 'runner-1', name: 'runner', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW,
  labels: [], capacity: 1, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 0,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'], botReview: true,
  },
} as PlacementRunnerRow;

it('US-003 AC-9: passes the GitLab write user through findRepo into the REVIEW ASSIGN payload', async () => {
  const job = {
    id: 'job-1', projectId: 'project-1', repoId: 'repo-1', command: 'REVIEW', state: FleetJobState.QUEUED,
    pinnedRunnerId: null, selectorLabels: [], profiles: [], bashMode: 'raw', feature: 'review-pr-7', ref: 'main',
    maxCostUsd: '5', planFrom: null, approvalTimeoutSec: 600, leaseEpoch: 0, reviewDecisions: [],
    prRulings: { notSent: 'head-unreadable' },
  };
  const repoRef = {
    id: 'repo-1', projectId: 'project-1', provider: 'gitlab', owner: 'acme', name: 'app', defaultBranch: 'main',
    host: 'https://gitlab.com', gitlabWriteUser: { id: 77, username: 'koda-bot' },
  };
  const repository = {
    lockById: vi.fn(async () => job),
    findRepo: vi.fn(async () => repoRef),
    lockRunners: vi.fn(async () => [runner.id]),
    findPlacementRunners: vi.fn(async () => [runner]),
    findActiveLoads: vi.fn(async () => []),
    findById: vi.fn(async () => job),
    casAssign: vi.fn(async () => 1),
    findRuleOverride: vi.fn(async () => null),
    setRuleOverrideSummary: vi.fn(async () => undefined),
    createCommand: vi.fn(async () => undefined),
  };
  const service = new PlacementService(
    repository as never,
    { record: vi.fn(async () => ({ live: {} })) } as never,
    { publish: vi.fn() } as never,
    { notify: vi.fn() } as never,
    { snapshot: vi.fn(async () => ({ runnerPaused: () => false, match: () => null })) } as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { runnerOfflineSec: 90 } as never,
    { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as never,
    {} as never,
    { availableProviders: vi.fn(async () => new Map()) } as never,
  );

  const outcome = await service.placeJob(job.id, NOW);
  expect(outcome.assigned).toBe(true);
  expect(repository.findRepo).toHaveBeenCalledWith(repoRef.id);
  const assign = repository.createCommand.mock.calls.find(([command]) => command.type === FleetCommandType.ASSIGN)?.[0];
  expect(assign).toBeDefined();
  expect(assign?.payload).toMatchObject({
    gitIdentity: { name: 'koda-bot' },
    review: { botLogin: 'koda-bot', prNumber: 7 },
  });
});
