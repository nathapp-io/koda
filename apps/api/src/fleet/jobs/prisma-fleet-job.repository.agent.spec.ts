import { Prisma } from '../../generated/prisma/client';
import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { FleetJobDto } from './dto/fleet-job.dto';
import type { AgentJobInput, AgentJobResult } from '../common/agent-jobs';
import type { FleetJobRecord } from './domain/fleet-job.domain';

/** A Prisma FleetJob row as the client answers it; `over` replaces the columns a case is about. */
const prismaRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'AGENT', feature: 'flow-a', planFrom: null,
  reviewDecisions: null, prRulings: null, profiles: [], maxCostUsd: new Prisma.Decimal('1'), bashMode: 'raw', approvalTimeoutSec: 600,
  selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: null, leaseEpoch: 0, state: 'QUEUED', stateReason: null,
  requestedById: 'u1', requestedByType: 'USER', createdAt: new Date(0), queuedAt: new Date(0), assignedAt: null, startedAt: null,
  finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null,
  currentStoryId: null, currentPhase: null, costSpentUsd: new Prisma.Decimal('0'), costCarriedUsd: new Prisma.Decimal('0'),
  firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  wipPush: null, stories: null, storiesTruncated: false, postRun: null, workflow: null, configResult: null,
  fixOutcome: null, fixReady: null, agentInput: null, agentResult: null, threadId: null, eventSeq: 0, ackedRunnerSeq: 0,
  attributedAt: null, updatedAt: new Date(0),
  ...over,
});

/** The repository over a client whose only job is answering `findById` with one stored row. */
const repositoryReading = (row: Record<string, unknown>): PrismaFleetJobRepository =>
  new PrismaFleetJobRepository({ client: { fleetJob: { findUnique: async () => row } } } as never);

const INPUT: AgentJobInput = { name: 'spec-reviewer', task: 'Review the spec' };
const RESULT: AgentJobResult = {
  status: 'completed', output: 'done', truncated: false, deniedAsks: [], deniedAsksTruncated: false, costUsd: '0.0123',
};

/** A domain record for the DTO cases; independent of Prisma, so it names every field it needs. */
const record = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'AGENT', feature: 'flow-a', planFrom: null,
  profiles: [], maxCostUsd: '1', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
  runnerId: null, runnerBootId: null, leaseEpoch: 0, state: 'QUEUED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date(0), assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null,
  naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0',
  costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0,
  scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null,
  resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,
  postRun: null, workflow: null, configResult: null, threadId: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null,
  updatedAt: new Date(0),
  ...over,
});

describe('agent columns through the repository', () => {
  it('AC-5: agentResult maps a stored result through the shape guard', async () => {
    const job = await repositoryReading(prismaRow({ agentResult: RESULT })).findById('j1');
    expect(job?.agentResult).toEqual(RESULT);
  });

  it.each([
    ['a status the protocol does not define', { ...RESULT, status: 'weird' }],
    ['no output', { status: 'completed', truncated: false, deniedAsks: [], deniedAsksTruncated: false }],
    ['deniedAsks that are not a list', { ...RESULT, deniedAsks: 'none' }],
    ['a denied ask of unknown kind', { ...RESULT, deniedAsks: [{ kind: 'nope', text: 'x' }] }],
    ['a string where the row stores something else', 'completed'],
  ])('AC-5: agentResult is null for %s', async (_case, stored) => {
    const job = await repositoryReading(prismaRow({ agentResult: stored })).findById('j1');
    expect(job?.agentResult).toBeNull();
  });

  it('AC-6: agentInput maps a stored input through the shape guard, optional fields included', async () => {
    const input: AgentJobInput = { name: 'spec-reviewer', task: 'Review', model: 'reviewer', modelAliases: { reviewer: 'acp:claude' }, timeoutSec: 600 };
    const job = await repositoryReading(prismaRow({ agentInput: input })).findById('j1');
    expect(job?.agentInput).toEqual(input);
  });

  it.each([
    ['no task', { name: 'spec-reviewer' }],
    ['no name', { task: 'Review the spec' }],
    ['a task that is not text', { name: 'spec-reviewer', task: 42 }],
    ['a bare string', 'spec-reviewer'],
    ['an array', [{ name: 'spec-reviewer', task: 'x' }]],
  ])('AC-6: agentInput is null for a stored value with %s', async (_case, stored) => {
    const job = await repositoryReading(prismaRow({ agentInput: stored })).findById('j1');
    expect(job?.agentInput).toBeNull();
  });

  it('AC-6: agentInput is null when the column is SQL null', async () => {
    const job = await repositoryReading(prismaRow()).findById('j1');
    expect(job?.agentInput).toBeNull();
    expect(job?.agentResult).toBeNull();
  });
});

describe('agent fields on FleetJobDto', () => {
  it('AC-7: from maps an AGENT record to agent and agentResult', () => {
    const dto = FleetJobDto.from(record({ agentInput: INPUT, agentResult: RESULT }));
    expect(dto.command).toBe('AGENT');
    expect(dto.agent).toEqual(INPUT);
    expect(dto.agentResult).toEqual(RESULT);
  });

  it('AC-8: from maps a RUN record to null agent and null agentResult', () => {
    const dto = FleetJobDto.from(record({ command: 'RUN' }));
    expect(dto.agent).toBeNull();
    expect(dto.agentResult).toBeNull();
  });
});

describe('agent columns on the write side', () => {
  /** The repository over a client that records the `data` of one create/update. */
  const repositoryWriting = (): { repository: PrismaFleetJobRepository; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } => {
    const create = vi.fn(async () => prismaRow({ agentInput: INPUT }));
    const update = vi.fn(async () => prismaRow({ agentInput: INPUT, agentResult: RESULT }));
    const repository = new PrismaFleetJobRepository({ client: { fleetJob: { create, update } } } as never);
    return { repository, create, update };
  };
  const dataOf = (call: unknown[]): Record<string, unknown> => (call[0] as { data: Record<string, unknown> }).data;
  const newJob = (over: Record<string, unknown> = {}) => ({
    projectId: 'p1', repoId: 'r1', ref: 'main', command: 'AGENT', feature: 'flow-a', planFrom: null, profiles: [],
    maxCostUsd: '1', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, requestedById: 'u1',
    ...over,
  });

  it('inserts the AGENT input as JSON', async () => {
    const { repository, create } = repositoryWriting();
    await repository.createJob({ ...newJob(), agentInput: INPUT } as never);
    expect(dataOf(create.mock.calls[0])['agentInput']).toEqual(INPUT);
  });

  it('inserts SQL null when the input is absent or explicitly null', async () => {
    const { repository, create } = repositoryWriting();
    await repository.createJob(newJob() as never);
    await repository.createJob({ ...newJob({ feature: 'flow-b' }), agentInput: null } as never);
    expect(dataOf(create.mock.calls[0])['agentInput']).toBe(Prisma.DbNull);
    expect(dataOf(create.mock.calls[1])['agentInput']).toBe(Prisma.DbNull);
  });

  it('patches the result as JSON, and clears the column with SQL null', async () => {
    const { repository, update } = repositoryWriting();
    await repository.update('j1', { agentResult: RESULT });
    await repository.update('j1', { agentResult: null });
    expect(dataOf(update.mock.calls[0])['agentResult']).toEqual(RESULT);
    expect(dataOf(update.mock.calls[1])['agentResult']).toBe(Prisma.DbNull);
  });

  it('leaves both columns out of a patch that does not name them', async () => {
    const { repository, update } = repositoryWriting();
    await repository.update('j1', { currentPhase: 'run' });
    expect(dataOf(update.mock.calls[0])).not.toHaveProperty('agentResult');
    expect(dataOf(update.mock.calls[0])).not.toHaveProperty('agentInput');
  });
});
