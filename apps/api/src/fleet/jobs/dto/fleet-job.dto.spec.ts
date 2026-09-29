import { FleetJobDto } from './fleet-job.dto';
import { FleetJobEventDto } from './fleet-job-event.dto';

describe('fleet job DTOs', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  it('serialise with decimals and dates as strings and hide internal columns', () => {
    const dto = FleetJobDto.from({
      id: 'j', projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5.5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: 'boot',
      leaseEpoch: 1, state: 'QUEUED', stateReason: null, requestedById: 'u', queuedAt: now, assignedAt: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
      progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0.1234', lastHeartbeatAt: null,
      finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
      eventSeq: 3, ackedRunnerSeq: 2, attributedAt: null, updatedAt: now,
    });
    const json = JSON.parse(JSON.stringify(dto));
    expect(json).toEqual(expect.objectContaining({ maxCostUsd: '5.5', costSpentUsd: '0.1234', queuedAt: now.toISOString() }));
    for (const hidden of ['runnerBootId', 'eventSeq', 'ackedRunnerSeq', 'attributedAt']) expect(json).not.toHaveProperty(hidden);
    expect(JSON.stringify(FleetJobEventDto.from({ id: 'e', jobId: 'j', seq: 1, leaseEpoch: 0, runnerSeq: null, type: 'state', payload: {}, createdAt: now }))).toContain('"seq":1');
  });
});
