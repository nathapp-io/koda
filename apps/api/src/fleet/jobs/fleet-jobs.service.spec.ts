import { NotFoundAppException } from '@nathapp/nestjs-common';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import type { Mock } from 'vitest';
import { FleetJobsService } from './fleet-jobs.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';

describe('fleet jobs service approvals count (S1.5 2a D272)', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  const record = (id: string): FleetJobRecord =>
    ({
      id, projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'escalate', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
      runnerId: null, runnerBootId: null, leaseEpoch: 1, state: 'RUNNING', stateReason: null, requestedById: 'u',
      queuedAt: now, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
      naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
      costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null,
      coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null,
      exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
      stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: now,
    }) as never;
  const projectId = 'p';
  const jobA = record('ja');
  const jobB = record('jb');
  let repo: { findPage: Mock; findById: Mock };
  let approvals: { countPendingByJob: Mock };
  let fleetTickets: { forJob: Mock };
  let configEdits: { findByJobId: Mock };
  let service: FleetJobsService;

  beforeEach(() => {
    repo = { findPage: vi.fn(), findById: vi.fn() };
    approvals = { countPendingByJob: vi.fn() };
    approvals.countPendingByJob.mockResolvedValue(new Map());
    fleetTickets = { forJob: vi.fn().mockResolvedValue([]) };
    configEdits = { findByJobId: vi.fn() };
    service = new FleetJobsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      approvals as never,
      fleetTickets as never,
      {} as never,
      configEdits as never,
      mockAuditRecorder,
    );
  });

  it('US-003 AC-11: requesterOf scopes the lookup to the project', async () => {
    repo.findById.mockResolvedValue({ ...jobA, id: 'j1', projectId: 'p1', requestedById: 'a1' });
    expect(await service.requesterOf('p1', 'j1')).toBe('a1');
    expect(repo.findById).toHaveBeenCalledWith('j1');
    await expect(service.requesterOf('other', 'j1')).rejects.toThrow(NotFoundAppException);
    await expect(service.requesterOf('other', 'j1')).rejects.toMatchObject({ response: { prefix: 'fleet.jobs' } });
    repo.findById.mockResolvedValue(null);
    await expect(service.requesterOf('p1', 'missing')).rejects.toMatchObject({ response: { prefix: 'fleet.jobs' } });
  });

  it('list counts pending approvals for the whole page in one query (D272)', async () => {
    repo.findPage.mockResolvedValue({ total: 2, current: 1, size: 20, hasNext: false, hasPrev: false, records: [jobA, jobB] });
    approvals.countPendingByJob.mockResolvedValue(new Map([[jobB.id, 3]]));
    const page = await service.list({ projectId }, { current: 1, size: 20 });
    expect(approvals.countPendingByJob).toHaveBeenCalledTimes(1);
    expect(approvals.countPendingByJob).toHaveBeenCalledWith([jobA.id, jobB.id]);
    expect(page.records.map((r) => r.pendingApprovals)).toEqual([0, 3]);
  });

  it('get counts the job pending approvals', async () => {
    repo.findById.mockResolvedValue(jobA);
    approvals.countPendingByJob.mockResolvedValue(new Map([[jobA.id, 1]]));
    expect((await service.get(projectId, jobA.id)).pendingApprovals).toBe(1);
  });

  describe('configEdit on the detail (fleet S3 §4.3)', () => {
    const cfg = (state: string, configResult: unknown) => ({ ...record('jc'), command: 'CONFIG_DRIFT', state, configResult }) as never;
    const row = { mode: 'drift', edits: [], prTitle: null, result: { outcome: 'drift', files: ['AGENTS.md'] } };

    it('shows the live result while active and the stored result once terminal; null for a nax job', async () => {
      configEdits.findByJobId.mockResolvedValue(row);
      repo.findById.mockResolvedValueOnce(cfg('RUNNING', { outcome: 'drift', files: [] }));
      expect((await service.get(projectId, 'jc')).configEdit).toEqual({ mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: [] } });
      repo.findById.mockResolvedValueOnce(cfg('COMPLETED', null));
      expect((await service.get(projectId, 'jc')).configEdit).toEqual({ mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: ['AGENTS.md'] } });
      repo.findById.mockResolvedValueOnce(jobA);
      expect((await service.get(projectId, 'ja')).configEdit).toBeNull();
    });
  });
});

describe('fleet jobs service dispatch audit key', () => {
  const queued: FleetJobRecord = {
    id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
    maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
    runnerId: null, runnerBootId: null, leaseEpoch: 1, state: 'QUEUED', stateReason: null, requestedById: 'u1',
    queuedAt: new Date('2026-10-01T00:00:00.000Z'), assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
    naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
    costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null,
    coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null, finishResult: null, escalationReason: null,
    exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null,
    stories: null, storiesTruncated: false, postRun: null, configResult: null, workflow: null, eventSeq: 0,
    ackedRunnerSeq: 0, attributedAt: null, threadId: null, updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  } as FleetJobRecord;

  const service = (): FleetJobsService => new FleetJobsService(
    {
      findRepo: vi.fn().mockResolvedValue({ id: 'r1', projectId: 'p1', provider: 'github', defaultBranch: 'main' }),
      createJob: vi.fn().mockResolvedValue(queued),
      appendEvent: vi.fn(),
      findById: vi.fn().mockResolvedValue(queued),
    } as never,
    { placeJob: vi.fn().mockResolvedValue({ assigned: false, runnerId: null, misfits: [] }) } as never,
    { record: vi.fn() } as never,
    { publish: vi.fn(), event: vi.fn() } as never,
    {} as never,
    { notify: vi.fn() } as never,
    { assertNotPaused: vi.fn() } as never,
    { run: vi.fn((fn: () => Promise<unknown>) => fn()) } as never,
    { countPendingByJob: vi.fn().mockResolvedValue(new Map()) } as never,
    { resolveForDispatch: vi.fn().mockResolvedValue([]), link: vi.fn(), forJob: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
    mockAuditRecorder,
  );

  const dto = { repoId: 'r1', command: 'RUN' as const, feature: 'f', maxCostUsd: 5 };

  beforeEach(() => {
    (mockAuditRecorder.record as unknown as Mock).mockClear();
  });

  it('AC-15: a dispatch call without opts.auditKey still records fleet.job.dispatch', async () => {
    await service().dispatch('u1', 'p1', dto);

    expect(mockAuditRecorder.record).toHaveBeenCalledTimes(1);
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({
      key: 'fleet.job.dispatch', resourceType: 'fleet-job', resourceId: 'j1', projectId: 'p1', summary: 'RUN on repo r1',
    });
  });
});

describe('fleet jobs service dispatch open-PR guard (#231)', () => {
  const repoRecord = { id: 'r', projectId: 'p', defaultBranch: 'main' };
  const tickets = [{ id: 't1', ref: 'KODA-1', title: 'x', status: 'CREATED' }];
  let repo: { findRepo: Mock };
  let fleetTickets: { resolveForDispatch: Mock; findOpenVcsPrLinks: Mock };
  let budgets: { assertNotPaused: Mock };
  let service: FleetJobsService;

  const build = (): void => {
    repo = { findRepo: vi.fn().mockResolvedValue(repoRecord) };
    fleetTickets = {
      resolveForDispatch: vi.fn((_projectId: string, refs?: readonly string[]) => Promise.resolve(refs && refs.length > 0 ? tickets : [])),
      findOpenVcsPrLinks: vi.fn().mockResolvedValue([{ ticketId: 't1', url: 'https://github.com/acme/widgets/pull/1' }]),
    };
    budgets = { assertNotPaused: vi.fn().mockRejectedValue(new Error('budget-stop-sentinel')) };
    service = new FleetJobsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      budgets as never,
      {} as never,
      {} as never,
      fleetTickets as never,
      {} as never,
      { findByJobId: vi.fn() } as never,
      mockAuditRecorder,
    );
  };

  const runDto = (over: Record<string, unknown> = {}) => ({
    repoId: 'r', command: 'RUN' as const, feature: 'f', maxCostUsd: 5, ticketRefs: ['KODA-1'], ...over,
  });

  it('refuses a RUN when a target ticket already has an open VCS PR', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto() as never)).rejects.toMatchObject({ code: 409 });
    expect(fleetTickets.findOpenVcsPrLinks).toHaveBeenCalledWith(['t1']);
  });

  it('skips the guard when acknowledgeOpenPr is set, and lets the dispatch continue', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto({ acknowledgeOpenPr: true }) as never)).rejects.toThrow('budget-stop-sentinel');
    expect(fleetTickets.findOpenVcsPrLinks).not.toHaveBeenCalled();
  });

  it('does not look up PRs when no tickets are targeted', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto({ ticketRefs: undefined }) as never)).rejects.toThrow('budget-stop-sentinel');
    expect(fleetTickets.findOpenVcsPrLinks).not.toHaveBeenCalled();
  });

  it('does not look up PRs for a PLAN dispatch', async () => {
    build();
    await expect(service.dispatch('u', 'p', runDto({ command: 'PLAN', planFrom: 'spec.md' }) as never)).rejects.toThrow('budget-stop-sentinel');
    expect(fleetTickets.findOpenVcsPrLinks).not.toHaveBeenCalled();
  });
});
