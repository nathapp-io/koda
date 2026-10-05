import { buildAssignPayload } from './assign-payload';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

const NOW = new Date('2026-10-01T00:00:00.000Z');

const job: FleetJobRecord = {
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: null,
  runnerBootId: null, leaseEpoch: 0, state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: NOW,
  assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null,
  naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', costCarriedUsd: '0',
  firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null,
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, eventSeq: 0, ackedRunnerSeq: 0,
  attributedAt: null, updatedAt: NOW,
};

const repo: FleetRepoRef = {
  id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main',
  githubInstallationId: BigInt(7),
};

const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };

describe('buildAssignPayload', () => {
  it('carries bashMode and approvalTimeoutSec from the job', () => {
    const payload = buildAssignPayload({ ...job, bashMode: 'escalate', approvalTimeoutSec: 120 }, repo, 'https://x/y.git', identity);
    expect(payload).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120 }));
  });
});
