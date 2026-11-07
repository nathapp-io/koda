import { buildAssignPayload } from './assign-payload';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

const NOW = new Date('2026-10-01T00:00:00.000Z');

const job: FleetJobRecord = {
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, threadId: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: null,
  runnerBootId: null, leaseEpoch: 0, state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: NOW,
  assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null,
  naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', costCarriedUsd: '0',
  firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null,
  resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0,
  attributedAt: null, updatedAt: NOW,
};

const repo: FleetRepoRef = {
  id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main',
  githubInstallationId: BigInt(7),
};

const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };

describe('buildAssignPayload', () => {
  it('US-003 AC-9: includes review metadata for REVIEW jobs', () => {
    const payload = buildAssignPayload({ ...job, command: 'REVIEW', feature: 'review-pr-42' }, repo, 'https://x/y.git', identity);
    expect(payload.review).toEqual({ prNumber: 42, botLogin: 'koda-fleet[bot]' });
  });

  it('US-003 AC-10: rejects malformed REVIEW features', () => {
    expect(() => buildAssignPayload({ ...job, command: 'REVIEW', feature: 'review-pr-x' }, repo, 'https://x/y.git', identity))
      .toThrow('invalid review feature');
  });

  it('US-003 AC-11: omits review metadata for RUN jobs', () => {
    const payload = buildAssignPayload(job, repo, 'https://x/y.git', identity);
    expect(payload).not.toHaveProperty('review');
  });

  it('carries bashMode and approvalTimeoutSec from the job', () => {
    const payload = buildAssignPayload({ ...job, bashMode: 'escalate', approvalTimeoutSec: 120 }, repo, 'https://x/y.git', identity);
    expect(payload).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120 }));
  });

  it('US-006 AC-9: includes expectBranch for thread PLAN jobs', () => {
    const payload = buildAssignPayload({ ...job, command: 'PLAN', ref: 'feat/add-auth', threadId: 't1' }, repo, 'https://x/y.git', identity);
    expect(payload).toHaveProperty('expectBranch', 'feat/add-auth');
  });

  it('US-006 AC-10/11: omits expectBranch for other jobs', () => {
    const plan = buildAssignPayload({ ...job, command: 'PLAN', threadId: null }, repo, 'https://x/y.git', identity);
    const run = buildAssignPayload({ ...job, command: 'RUN', threadId: 't1' }, repo, 'https://x/y.git', identity);
    expect(plan).not.toHaveProperty('expectBranch');
    expect(run).not.toHaveProperty('expectBranch');
  });

  it('US-007 AC-6: a RUN job from a thread plan has no expectBranch key, even with a threadId', () => {
    const run = buildAssignPayload({ ...job, command: 'RUN', ref: 'feat/add-auth', planFrom: null, threadId: 't1' }, repo, 'https://x/y.git', identity);
    expect(run).not.toHaveProperty('expectBranch');
    expect(run.planFrom).toBeNull();
  });

  it('US-006: includes the supplied THREAD assignment block', () => {
    const thread = {
      threadId: 't1', action: 'SESSION' as const, feature: 'add-auth', resume: false, instructions: 'instructions',
      backend: { kind: 'native' as const }, skills: [], initialMessage: { messageId: 'm1', text: 'hello' },
    };
    expect(buildAssignPayload({ ...job, command: 'THREAD' }, repo, 'https://x/y.git', identity, thread).thread).toEqual(thread);
  });
});

describe('FIX assign detected-check trust (US-002)', () => {
  it('AC-1: opts FIX into detected-check trust when repo setting is true', () => {
    const payload = buildAssignPayload({ ...job, command: 'FIX', feature: 'review-pr-7' }, { ...repo, fixTrustDetectedChecks: true }, 'https://x/y.git', identity);
    expect(payload.review).toEqual({ prNumber: 7, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true });
  });

  it('AC-2: omits detected-check trust when repo setting is false', () => {
    const payload = buildAssignPayload({ ...job, command: 'FIX', feature: 'review-pr-7' }, { ...repo, fixTrustDetectedChecks: false }, 'https://x/y.git', identity);
    expect(payload.review).not.toHaveProperty('trustDetectedChecks');
  });

  it('AC-3: omits detected-check trust when repo setting is missing', () => {
    const payload = buildAssignPayload({ ...job, command: 'FIX', feature: 'review-pr-7' }, repo, 'https://x/y.git', identity);
    expect(payload.review).not.toHaveProperty('trustDetectedChecks');
  });

  it('AC-4: never sends detected-check trust for REVIEW jobs', () => {
    const payload = buildAssignPayload({ ...job, command: 'REVIEW', feature: 'review-pr-7' }, { ...repo, fixTrustDetectedChecks: true }, 'https://x/y.git', identity);
    expect(payload.review).not.toHaveProperty('trustDetectedChecks');
  });
});

describe('FIX assign review payload (US-003)', () => {
  const decision = { id: 'm1', statement: 'auth: tokens live in Redis', source: 'koda:memory/m1' };
  it('AC-9: includes PR, bot identity and stored decisions for FIX', () => {
    const payload = buildAssignPayload({ ...job, command: 'FIX', feature: 'review-pr-9', reviewDecisions: [decision] }, repo, 'https://x/y.git', identity);
    expect(payload.review).toEqual({ prNumber: 9, botLogin: 'koda-fleet[bot]', decisions: [decision] });
  });
  it('AC-10: rejects malformed FIX features', () => {
    expect(() => buildAssignPayload({ ...job, command: 'FIX', feature: 'review-pr-x' }, repo, 'https://x/y.git', identity))
      .toThrow('invalid review feature');
  });
});

describe('review decision snapshot wire', () => {
  const decisions = [{ id: 'm1', statement: 'auth: tokens live in Redis', source: 'koda:memory/m1' }];
  it('AC-11 sends the stored decisions', () => {
    expect(buildAssignPayload({ ...job, command: 'REVIEW', feature: 'review-pr-42', reviewDecisions: decisions }, repo, 'https://x/y.git', identity).review?.decisions).toEqual(decisions);
  });
  it.each([{ reviewDecisions: [] }, { reviewDecisions: null }])('AC-12/13 omits an empty snapshot $reviewDecisions', ({ reviewDecisions }) => {
    expect(buildAssignPayload({ ...job, command: 'REVIEW', feature: 'review-pr-42', reviewDecisions }, repo, 'https://x/y.git', identity).review).not.toHaveProperty('decisions');
  });
});

/**
 * US-005: an AGENT assignment carries the dispatch input as its `agent` block, and never a `review` block —
 * the runner runs the named agent instead of a PR review, so a review block on an AGENT payload would make it
 * look like a REVIEW job.
 */
describe('AGENT assign payload (US-005)', () => {
  const agentInput = { name: 'spec-reviewer', task: 'x', modelAliases: { reviewer: 'acp:claude' } };

  it('AC-4: carries the agent block and no review block for an AGENT job', () => {
    const payload = buildAssignPayload({ ...job, command: 'AGENT', agentInput }, repo, 'https://x/y.git', identity);
    expect(payload.agent).toEqual(agentInput);
    expect(payload).not.toHaveProperty('review');
  });

  it('AC-4: an AGENT job whose feature looks like a review feature still gets no review block', () => {
    const payload = buildAssignPayload({ ...job, command: 'AGENT', feature: 'review-pr-7', agentInput }, repo, 'https://x/y.git', identity);
    expect(payload.agent).toEqual(agentInput);
    expect(payload).not.toHaveProperty('review');
  });

  it('AC-5: a RUN job carries no agent key, even with an agent block on the record', () => {
    const run = buildAssignPayload(job, repo, 'https://x/y.git', identity);
    expect(run).not.toHaveProperty('agent');
    // A record that (wrongly) holds an agent block must not leak it onto a non-AGENT payload either.
    expect(buildAssignPayload({ ...job, agentInput }, repo, 'https://x/y.git', identity)).not.toHaveProperty('agent');
  });

  it('refuses to build an AGENT payload with no dispatch input instead of sending an unusable ASSIGN', () => {
    expect(() => buildAssignPayload({ ...job, command: 'AGENT' }, repo, 'https://x/y.git', identity)).toThrow('invalid agent input');
  });
});
