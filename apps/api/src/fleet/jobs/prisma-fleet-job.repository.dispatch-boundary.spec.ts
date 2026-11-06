import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { normalizeDispatch } from './dispatch-input';
import type { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';

const row = {
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'feature-a', planFrom: null,
  reviewDecisions: null, prRulings: null, profiles: [], maxCostUsd: { toString: () => '1' }, bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: null, leaseEpoch: 0, state: 'QUEUED', stateReason: null,
  requestedById: 'u1', requestedByType: 'USER', queuedAt: new Date(0), assignedAt: null, startedAt: null, finishedAt: null,
  cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null,
  currentPhase: null, costSpentUsd: { toString: () => '0' }, costCarriedUsd: { toString: () => '0' }, firstStartedAt: null,
  cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null, configResult: null,
  fixOutcome: null, fixReady: null, threadId: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: new Date(0),
};

describe('dispatch normalization through the pre-agent persistence boundary', () => {
  it.each([
    [{ command: 'RUN', feature: 'feature-a', maxCostUsd: 1 }, 'RUN'],
    [{ command: 'PLAN', feature: 'feature-a', planFrom: 'specs/a.md', maxCostUsd: 1 }, 'PLAN'],
  ] as const)('%s remains compatible with Prisma job insertion', async (input) => {
    const create = vi.fn(async () => ({ ...row, command: input.command }));
    const repository = new PrismaFleetJobRepository({ client: { fleetJob: { create } } } as never);
    const normalized = normalizeDispatch({ repoId: 'r1', ...input } as DispatchFleetJobDto, 'main');

    await repository.createJob({ ...normalized, projectId: 'p1', requestedById: 'u1' });

    const [args] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(args.data).not.toHaveProperty('agentInput');
  });
});
