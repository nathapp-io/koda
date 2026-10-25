import type { LiveFleetApprovalEvent, LiveFleetJobEvent } from '../../live/live-event';
import { currentContext, type ActionContext } from '../../action-context/action-context';
import { FleetSweeper } from './fleet-sweeper';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

describe('FleetSweeper scheduling', () => {
  afterEach(() => vi.useRealTimers());

  it('starts a 30s interval only when enabled, and stops it on shutdown', () => {
    vi.useFakeTimers();
    const off = new FleetSweeper({} as never, {} as never, {} as never, {} as never, testFleetConfig({ sweepEnabled: false }), {} as never, {} as never, {} as never, mockAuditRecorder);
    off.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    const on = new FleetSweeper({} as never, {} as never, {} as never, {} as never, testFleetConfig({ sweepEnabled: true }), {} as never, {} as never, {} as never, mockAuditRecorder);
    on.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    on.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('FleetSweeper background context (US-004)', () => {
  afterEach(() => vi.useRealTimers());

  it('AC-10: the interval callback scans for silent held jobs as SYSTEM/job', async () => {
    vi.useFakeTimers();
    const seen: Array<ActionContext | undefined> = [];
    const repo = {
      findSilentHeldIds: vi.fn(async () => {
        seen.push(currentContext());
        return [];
      }),
    };
    const sweeper = new FleetSweeper(
      repo as never, {} as never, {} as never, { run: (fn: () => unknown) => fn() } as never,
      testFleetConfig({ sweepEnabled: true }), {} as never, {} as never, {} as never, mockAuditRecorder,
    );

    sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    sweeper.onModuleDestroy();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'job' });
  });
});

describe('FleetSweeper tick (S1.5 2a: job leaves RUNNING)', () => {
  it('crashes a silent runner-held job and publishes both live lists (plan D263)', async () => {
    const NOW = new Date('2026-10-03T10:00:00.000Z');
    const APPROVAL_LIVE: LiveFleetApprovalEvent = { id: 'lv-1', type: 'fleet_approval', projectId: 'p1', approvalId: 'a1', status: 'cancelled', at: NOW.toISOString() };
    const JOB_LIVE: LiveFleetJobEvent = { id: 'e1', type: 'fleet_job', projectId: 'p1', jobId: 'job-1', state: 'CRASHED', at: NOW.toISOString() };
    const job = { id: 'job-1', projectId: 'p1', runnerId: 'r1', state: 'RUNNING' };
    vi.mocked(mockAuditRecorder.record).mockClear();
    const repo = {
      findSilentHeldIds: vi.fn(async () => ['job-1']),
      lockById: vi.fn(async () => job),
      findPlacementRunners: vi.fn(async () => [{ lastSeenAt: new Date(0) }]),
    };
    const transitions = { apply: vi.fn(async () => ({ job, live: JOB_LIVE, approvalLive: [APPROVAL_LIVE] })) };
    const live = { publish: vi.fn() };
    const approvalLive = { publish: vi.fn() };
    const ticketEffects = { onTerminal: vi.fn() };
    const sweeper = new FleetSweeper(
      repo as never, transitions as never, live as never, { run: (fn: () => unknown) => fn() } as never,
      testFleetConfig({ sweepEnabled: true, jobCrashSec: 60 }), { attribute: vi.fn() } as never, approvalLive as never, ticketEffects as never, mockAuditRecorder,
    );
    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
    expect(transitions.apply).toHaveBeenCalledWith(expect.objectContaining({ job, to: 'CRASHED', by: 'server', reason: 'runner silent' }));
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({
      key: 'system.job.crash-silent-runner', resourceType: 'fleet-job', resourceId: job.id,
      projectId: job.projectId, summary: 'RUNNING -> CRASHED',
    });
    expect(live.publish).toHaveBeenCalledWith([JOB_LIVE]);
    expect(approvalLive.publish).toHaveBeenCalledWith([APPROVAL_LIVE]);
    expect(ticketEffects.onTerminal).toHaveBeenCalledWith([job.id]);
  });
});
