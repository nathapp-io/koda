import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';

/**
 * US-004: `toJob` maps the nullable `FleetJob.fixOutcome` TEXT column through `fixOutcomeOf`, so a value written
 * outside the union never reaches the domain as-is and a patch carrying the field reaches Prisma as a column.
 * `fixOutcomeOf` itself is pinned by AC-5/AC-6 in `domain/fleet-job.domain.spec.ts`; this pins the mapping the
 * repository applies with it (`toJob` had no unit coverage at all).
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'FIX', feature: 'review-pr-7', planFrom: null,
  reviewDecisions: null, profiles: [], maxCostUsd: 5, bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [],
  pinnedRunnerId: null, runnerId: null, runnerBootId: null, leaseEpoch: 0, state: 'FAILED', stateReason: null,
  requestedById: 'u1', requestedByType: 'USER', queuedAt: new Date(0), assignedAt: null, startedAt: null,
  finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: 0, costCarriedUsd: 0,
  firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null,
  resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null,
  workflow: null, configResult: null, threadId: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null,
  updatedAt: new Date(0), ...over,
});

const repoOver = (delegate: Record<string, unknown>) =>
  new PrismaFleetJobRepository({ client: { fleetJob: delegate } } as never);

describe('PrismaFleetJobRepository fixOutcome mapping (US-004)', () => {
  it.each(['pushed', 'nothing'])('keeps the stored %s as the domain outcome', async (value) => {
    const repo = repoOver({ findUnique: vi.fn(async () => row({ fixOutcome: value })) });
    expect((await repo.findById('j1'))?.fixOutcome).toBe(value);
  });

  it.each([[null], ['garbage'], [''], ['PUSHED']])('reads a stored %p as null', async (value) => {
    const repo = repoOver({ findUnique: vi.fn(async () => row({ fixOutcome: value })) });
    expect((await repo.findById('j1'))?.fixOutcome).toBeNull();
  });

  it('maps the column of a row written before it existed (no key) to null', async () => {
    const legacy = { ...row(), fixOutcome: undefined };
    const repo = repoOver({ findUnique: vi.fn(async () => legacy) });
    expect((await repo.findById('j1'))?.fixOutcome).toBeNull();
  });

  it('passes a patch carrying fixOutcome to Prisma as a column value and maps the answer back', async () => {
    const update = vi.fn(async () => row({ fixOutcome: 'pushed' }));
    const repo = repoOver({ update });

    const record = await repo.update('j1', { fixOutcome: 'pushed' });

    const [args] = update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(args.data).toEqual(expect.objectContaining({ fixOutcome: 'pushed' }));
    expect(record.fixOutcome).toBe('pushed');
  });

  it('sends a null fixOutcome, so a requeue clears the column', async () => {
    const update = vi.fn(async () => row({ fixOutcome: null }));
    const repo = repoOver({ update });

    const record = await repo.update('j1', { fixOutcome: null });

    const [args] = update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(args.data).toEqual(expect.objectContaining({ fixOutcome: null }));
    expect(record.fixOutcome).toBeNull();
  });
});
