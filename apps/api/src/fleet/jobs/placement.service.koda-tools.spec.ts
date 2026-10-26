import { FleetCommandType, FleetJobState } from '../../common/enums';
import { KODA_TOOL_DESCRIPTORS } from '../assistant/koda-tool-descriptors';
import type { PlacementRunnerRow } from './domain/fleet-job.domain';
import { PlacementService } from './placement.service';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';

/**
 * US-005 (1b-D3): a THREAD job's ASSIGN carries the static koda tool descriptors only for a SESSION turn placed on a
 * runner advertising `kodaTools` (S5b-R9). The catalog is a plain module, so placement imports it directly and
 * `FleetJobsModule` never imports the assistant module. Drives the real placement entry points with fake
 * collaborators, no database.
 */
const NOW = new Date('2026-10-17T12:00:00.000Z');

const runnerRow = (over: Partial<PlacementRunnerRow> = {}): PlacementRunnerRow => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000), bootedAt: NOW, labels: [],
  capacity: 1, bootId: 'boot-1', protocolVersion: 4, threadCapacity: 2,
  capabilities: {
    nax: { version: '0.83.0', protocols: ['native'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'],
    threadBackends: { native: ['m1'], acp: [] },
    threadWrite: true,
  },
  ...over,
} as PlacementRunnerRow);

/** The fixture runner with `kodaTools: true` reported (1b-D1 / SEAM-4). */
const withKodaTools = (runner: PlacementRunnerRow): PlacementRunnerRow =>
  ({ ...runner, capabilities: { ...runner.capabilities, kodaTools: true } });

const threadAssign = (action: 'SESSION' | 'PUBLISH' | 'DISCARD') => ({
  threadId: 't1', action, kind: 'REPO' as const, feature: 'auth', resume: false, instructions: 'go',
  backend: { kind: 'native', model: 'm1' }, skills: [], initialMessage: null,
});

/** Fake collaborators for one QUEUED THREAD job whose turn is `action`; both entry points read the same fakes. */
function fixture(action: 'SESSION' | 'PUBLISH' | 'DISCARD', runners: PlacementRunnerRow[]) {
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
    findThreadAssign: vi.fn(async () => threadAssign(action)),
    createCommand: vi.fn(async () => {
      expect(currentBookkeepingReason()).toBe('fleet.placement');
      return {};
    }),
    casAssign: vi.fn(async () => {
      expect(currentBookkeepingReason()).toBe('fleet.placement');
      return 1;
    }),
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
  /** The payload of the one ASSIGN command the service queued. */
  const assignPayload = (): Record<string, unknown> => {
    const call = repo.createCommand.mock.calls.find(([c]: [{ type: FleetCommandType }]) => c.type === FleetCommandType.ASSIGN);
    expect(call).toBeDefined();
    return (call as unknown as [{ payload: Record<string, unknown> }])[0].payload;
  };
  return { service, assignPayload };
}

describe('US-005 AC-12: assign attaches the koda tool descriptors to a SESSION ASSIGN', () => {
  it('names every KODA_TOOL_DESCRIPTORS entry, in order, on a runner with kodaTools', async () => {
    const { service, assignPayload } = fixture('SESSION', [withKodaTools(runnerRow())]);
    await service.placeJob('j1', NOW);
    const thread = assignPayload().thread as { kodaTools: Array<{ name: string }> };
    expect(thread.kodaTools.map((tool) => tool.name)).toEqual(KODA_TOOL_DESCRIPTORS.map((tool) => tool.name));
  });

  it('carries the whole descriptors, not only their names', async () => {
    const { service, assignPayload } = fixture('SESSION', [withKodaTools(runnerRow())]);
    await service.placeJob('j1', NOW);
    const thread = assignPayload().thread as { kodaTools: unknown };
    expect(thread.kodaTools).toEqual([...KODA_TOOL_DESCRIPTORS]);
  });

  it('attaches them through fillRunnerThreads (the runner sync path) too', async () => {
    const { service, assignPayload } = fixture('SESSION', [withKodaTools(runnerRow())]);
    await service.fillRunnerThreads('r1', NOW);
    const thread = assignPayload().thread as { kodaTools: Array<{ name: string }> };
    expect(thread.kodaTools.map((tool) => tool.name)).toEqual(KODA_TOOL_DESCRIPTORS.map((tool) => tool.name));
  });
});

describe('US-005 AC-13: no descriptors without the capability or off a SESSION turn', () => {
  it('leaves kodaTools out for a SESSION on a runner that never reported it', async () => {
    const { service, assignPayload } = fixture('SESSION', [runnerRow()]);
    await service.placeJob('j1', NOW);
    expect(assignPayload().thread as object).not.toHaveProperty('kodaTools');
  });

  it('leaves kodaTools out for a PUBLISH on a runner with kodaTools', async () => {
    const { service, assignPayload } = fixture('PUBLISH', [withKodaTools(runnerRow())]);
    await service.placeJob('j1', NOW);
    expect(assignPayload().thread as object).not.toHaveProperty('kodaTools');
  });

  it('leaves kodaTools out for a DISCARD on a runner with kodaTools', async () => {
    const { service, assignPayload } = fixture('DISCARD', [withKodaTools(runnerRow())]);
    await service.placeJob('j1', NOW);
    expect(assignPayload().thread as object).not.toHaveProperty('kodaTools');
  });
});
