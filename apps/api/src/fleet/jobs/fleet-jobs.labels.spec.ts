import { FleetJobDto } from './dto/fleet-job.dto';
import { FleetJobsService } from './fleet-jobs.service';
import { PrismaFleetJobLabelsRepository } from './prisma-fleet-job-labels.repository';
import type { FleetJobRecord } from './domain/fleet-job.domain';

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'THREAD', feature: 'thread-th1', planFrom: null,
  profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
  runnerId: null, runnerBootId: null, leaseEpoch: 0, state: 'QUEUED', stateReason: null, requestedById: 'u1',
  queuedAt: new Date('2026-01-01T00:00:00.000Z'), assignedAt: null, startedAt: null, finishedAt: null,
  cancelRequestedAt: null, cancelReason: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', costCarriedUsd: '0',
  firstStartedAt: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  wipPush: null, stories: null, storiesTruncated: false, postRun: null, configResult: null, workflow: null,
  eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: new Date('2026-01-01T00:00:00.000Z'), threadId: 'th1',
  ...overrides,
}) as FleetJobRecord;

const build = (records: FleetJobRecord[], labels?: { read: ReturnType<typeof vi.fn> }) => {
  const repo = { findPage: vi.fn().mockResolvedValue({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false }), findById: vi.fn().mockResolvedValue(records[0]) };
  const approvals = { countPendingByJob: vi.fn().mockResolvedValue(new Map()) };
  const tickets = { forJob: vi.fn().mockResolvedValue([]) };
  const service = new FleetJobsService(repo as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, approvals as never, tickets as never, {} as never, { findByJobId: vi.fn() } as never,
    {} as never, {} as never, {} as never, labels as never);
  return service;
};

describe('fleet job readable labels', () => {
  it('AC-1: DTO defaults requester and thread labels to null', () => {
    const dto = FleetJobDto.from(job());
    expect(dto.requesterName).toBeNull();
    expect(dto.threadTitle).toBeNull();
  });

  it('AC-2/3: list reads one projected page and applies requester/thread labels', async () => {
    const read = vi.fn().mockResolvedValue({ names: new Map([['u1', 'Alice']]), threads: new Map([['th1', 'Fix login flow']]) });
    const result = await build([job()], { read }).list({ projectId: 'p1' } as never, { current: 1, size: 20 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([{ requestedById: 'u1', threadId: 'th1' }]);
    expect(result.records[0]).toMatchObject({ requesterName: 'Alice', threadTitle: 'Fix login flow' });
  });

  it('AC-4/5: missing optional labels yield null despite unrelated thread labels', async () => {
    const read = vi.fn().mockResolvedValue({ names: new Map(), threads: new Map([['elsewhere', 'Other']]) });
    const result = await build([job({ requestedById: 'gone', threadId: null })], { read }).list({} as never, { current: 1, size: 20 });
    expect(result.records[0]).toMatchObject({ requesterName: null, threadTitle: null });
  });

  it('AC-6: get reads once and includes an agent requester label when thread is absent', async () => {
    const read = vi.fn().mockResolvedValue({ names: new Map([['a1', 'codex-bot']]), threads: new Map() });
    const result = await build([job({ requestedById: 'a1', threadId: null })], { read }).get('p1', 'j1');
    expect(read).toHaveBeenCalledExactlyOnceWith([{ requestedById: 'a1', threadId: null }]);
    expect(result.requesterName).toBe('codex-bot');
  });

  it('AC-7: a PLAN job with a thread gets the thread title', async () => {
    const read = vi.fn().mockResolvedValue({ names: new Map(), threads: new Map([['th1', 'Fix login flow']]) });
    const result = await build([job({ command: 'PLAN' })], { read }).list({} as never, { current: 1, size: 20 });
    expect(result.records[0].threadTitle).toBe('Fix login flow');
  });

  it('AC-8: list without an optional labels reader preserves null defaults', async () => {
    const result = await build([job()]).list({} as never, { current: 1, size: 20 });
    expect(result.records[0]).toMatchObject({ requesterName: null, threadTitle: null });
  });

  it('AC-9: repository batches thread titles and uses readPrincipalNames', async () => {
    const userFindMany = vi.fn().mockResolvedValue([{ id: 'u1', name: 'Alice', email: 'a@x.io' }]);
    const agentFindMany = vi.fn().mockResolvedValue([]);
    const chatThreadFindMany = vi.fn().mockResolvedValue([{ id: 'th1', title: 'Fix login flow' }]);
    const repository = new PrismaFleetJobLabelsRepository({ client: {
      user: { findMany: userFindMany }, agent: { findMany: agentFindMany },
      chatThread: { findMany: chatThreadFindMany },
    } } as never);
    const result = await repository.read([{ requestedById: 'u1', threadId: 'th1' }, { requestedById: 'u1', threadId: null }]);
    expect(chatThreadFindMany).toHaveBeenCalledTimes(1);
    expect(chatThreadFindMany).toHaveBeenCalledWith({ where: { id: { in: ['th1'] } }, select: { id: true, title: true } });
    expect(result.names.get('u1')).toBe('Alice');
    expect(result.threads.get('th1')).toBe('Fix login flow');
  });
});
