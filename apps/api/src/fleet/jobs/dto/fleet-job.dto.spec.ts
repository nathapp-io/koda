import { FleetJobDto } from './fleet-job.dto';
import { FleetJobEventDto } from './fleet-job-event.dto';

describe('fleet job DTOs', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  it('serialise with decimals and dates as strings and hide internal columns', () => {
    const dto = FleetJobDto.from({
      id: 'j', projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5.5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: 'boot',
      leaseEpoch: 1, state: 'QUEUED', stateReason: null, requestedById: 'u', queuedAt: now, assignedAt: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
      progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0.1234', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: 's1', coalescedCount: 2, scheduleCountedAt: null, lastHeartbeatAt: null,
      finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
      wipPush: 'failed:diverged', stories: [{ id: 'US-001', title: 't', status: 'passed', attempts: 1, dependsOn: [] }], storiesTruncated: true, postRun: null,
      eventSeq: 3, ackedRunnerSeq: 2, attributedAt: null, updatedAt: now,
    });
    const json = JSON.parse(JSON.stringify(dto));
    expect(json).toEqual(expect.objectContaining({ maxCostUsd: '5.5', costSpentUsd: '0.1234', queuedAt: now.toISOString() }));
    expect(json).toEqual(expect.objectContaining({ wipPush: 'failed:diverged' }));
    expect(json).toEqual(expect.objectContaining({ scheduleId: 's1', coalescedCount: 2 }));
    expect(json).toEqual(expect.objectContaining({ stories: [{ id: 'US-001', title: 't', status: 'passed', attempts: 1, dependsOn: [] }], storiesTruncated: true }));
    for (const hidden of ['runnerBootId', 'eventSeq', 'ackedRunnerSeq', 'attributedAt', 'scheduleCountedAt']) expect(json).not.toHaveProperty(hidden);
    expect(JSON.stringify(FleetJobEventDto.from({ id: 'e', jobId: 'j', seq: 1, leaseEpoch: 0, runnerSeq: null, type: 'state', payload: {}, createdAt: now }))).toContain('"seq":1');
  });

  it('a list page leaves the story list out (D149); a single job carries it', () => {
    const record = {
      id: 'j', projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: null,
      leaseEpoch: 1, state: 'RUNNING', stateReason: null, requestedById: 'u', queuedAt: now, assignedAt: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
      progress: null, currentStoryId: 'US-001', currentPhase: 'implement', costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null, lastHeartbeatAt: null,
      finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
      wipPush: null, stories: [{ id: 'US-001', title: 't', status: 'in-progress', attempts: 0, dependsOn: [] }], storiesTruncated: true, postRun: null,
      eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: now,
    } as const;
    const full = JSON.parse(JSON.stringify(FleetJobDto.from({ ...record, stories: [...record.stories] } as never)));
    expect(full).toEqual(expect.objectContaining({ stories: [record.stories[0]], storiesTruncated: true }));
    const summary = JSON.parse(JSON.stringify(FleetJobDto.summary({ ...record, stories: [...record.stories] } as never)));
    expect(summary).toEqual(expect.objectContaining({ id: 'j', currentStoryId: 'US-001', stories: null, storiesTruncated: false }));
  });

  it('maps bashMode, approvalTimeoutSec and pendingApprovals (S1.5 §1.6)', () => {
    const record = { id: 'j', bashMode: 'raw', approvalTimeoutSec: 600, queuedAt: now };
    const dto = FleetJobDto.from({ ...record, bashMode: 'escalate', approvalTimeoutSec: 120 } as never, 2);
    expect(dto).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120, pendingApprovals: 2 }));
    expect(FleetJobDto.summary(record as never).pendingApprovals).toBe(0);
  });
});
