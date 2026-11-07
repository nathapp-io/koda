import { Prisma } from '../../generated/prisma/client';
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
  fixOutcome: null, fixReady: null, agentInput: null, agentResult: null, threadId: null, eventSeq: 0, ackedRunnerSeq: 0,
  attributedAt: null, updatedAt: new Date(0),
};

describe('dispatch normalization through the agent persistence boundary', () => {
  it.each([
    [{ command: 'RUN', feature: 'feature-a', maxCostUsd: 1 }, 'RUN'],
    [{ command: 'PLAN', feature: 'feature-a', planFrom: 'specs/a.md', maxCostUsd: 1 }, 'PLAN'],
  ] as const)('%s remains compatible with Prisma job insertion', async (input) => {
    const create = vi.fn(async () => ({ ...row, command: input.command }));
    const repository = new PrismaFleetJobRepository({ client: { fleetJob: { create } } } as never);
    const normalized = normalizeDispatch({ repoId: 'r1', ...input } as DispatchFleetJobDto, 'main');

    await repository.createJob({ ...normalized, projectId: 'p1', requestedById: 'u1' });

    const [args] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    // US-003: the column exists now, and a command with no agent input stores SQL null rather than JSON null.
    expect(args.data.agentInput).toBe(Prisma.DbNull);
  });

  it.each([
    ['a task', { name: 'spec-reviewer', task: 'review\u0000this' }],
    ['a model', { name: 'spec-reviewer', task: 'Review', model: 'model\u0000x' }],
    ['a model alias target', { name: 'spec-reviewer', task: 'Review', modelAliases: { reviewer: 'openai/gpt\u00005.4' } }],
  ] as const)('refuses agent text PostgreSQL cannot store, in %s, before any insert', async (_case, agent) => {
    // jsonb answers SQLSTATE 22P05 ("unsupported Unicode escape sequence") for U+0000, so a dispatch that reaches
    // createJob with one is a 500, not a validation response. The two steps a dispatch takes are normalize → insert.
    const create = vi.fn(async () => row);
    const repository = new PrismaFleetJobRepository({ client: { fleetJob: { create } } } as never);
    const dispatch = async (): Promise<void> => {
      const normalized = normalizeDispatch({ repoId: 'r1', command: 'AGENT', feature: 'feature-a', maxCostUsd: 1, agent } as DispatchFleetJobDto, 'main');
      await repository.createJob({ ...normalized, projectId: 'p1', requestedById: 'u1' });
    };

    await expect(dispatch()).rejects.toMatchObject({ prefix: 'fleet.dispatchInput' });
    expect(create).not.toHaveBeenCalled();
  });
});
