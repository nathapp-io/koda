import { buildAssignPayload } from './assign-payload';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';
import { EMPTY_LOAD, firstMisfit, PERMANENT_MISFITS, toPlacementJob } from './placement-rules';
import type { PlacementRunner } from './placement-rules';
import { parseCapabilities } from '../common/capabilities';
import { MISFIT_REASONS } from '../dashboard/dashboard.types';

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


const ruling = { rulingId: 'internal-id', item: 'D-1', ruling: 'confirm: checked the test', by: 'koda:user:Dev', at: NOW.toISOString() };
const snapshot = { headSha: 'a'.repeat(40), rulings: [ruling] };
const fix = { ...job, command: 'FIX' as const, feature: 'review-pr-42', prRulings: snapshot };
const capabilities = {
  nax: { version: '1', protocols: ['native' as const] },
  sandbox: { available: true, probedAt: NOW.toISOString() }, profiles: {}, credentials: [],
  tools: { git: true, gh: true, glab: false }, executors: ['host' as const], botReview: true as const, botFix: true as const,
};
const runner: PlacementRunner = { id: 'r1', name: 'runner', enabled: true, lastSeenAt: NOW, labels: [], capacity: 1, capabilities };

describe('FIX caller rulings', () => {
  it('AC-1 projects the stored snapshot without internal rulingId', () => {
    const payload = buildAssignPayload(fix, repo, 'https://x/y.git', identity);
    expect(payload.review).toEqual({ prNumber: 42, botLogin: identity.name, rulings: {
      headSha: snapshot.headSha, rulings: [{ item: ruling.item, ruling: ruling.ruling, by: ruling.by, at: ruling.at }],
    } });
  });
  it('AC-2 omits rulings when the head is unreadable', () => {
    expect(buildAssignPayload({ ...fix, prRulings: { notSent: 'head-unreadable' } }, repo, 'https://x/y.git', identity).review)
      .toEqual({ prNumber: 42, botLogin: identity.name });
  });
  it.each(['REVIEW', 'RUN'] as const)('never sends rulings for %s', (command) => {
    expect(buildAssignPayload({ ...fix, command }, repo, 'https://x/y.git', identity)).not.toHaveProperty('review.rulings');
    expect(toPlacementJob({ ...fix, command }, repo)).not.toHaveProperty('needsBotRulings');
  });
  it('AC-3 marks a FIX with non-empty rulings for placement', () => {
    expect(toPlacementJob(fix, repo)).toHaveProperty('needsBotRulings', true);
  });
  it('AC-4 refuses a runner lacking botRulings', () => {
    const placement = { ...toPlacementJob(fix, repo), needsBotRulings: true as const };
    expect(firstMisfit(placement, runner, EMPTY_LOAD, NOW, 90)).toBe('bot_rulings');
  });
  it('AC-5 fits the same job on a botRulings runner', () => {
    const placement = { ...toPlacementJob(fix, repo), needsBotRulings: true as const };
    const capable = { ...runner, capabilities: { ...capabilities, botRulings: true as const } };
    expect(firstMisfit(placement, capable, EMPTY_LOAD, NOW, 90)).toBeNull();
  });
  it('AC-6 ordinary FIX needs no new runner capability', () => {
    expect(firstMisfit(toPlacementJob({ ...fix, prRulings: undefined }, repo), runner, EMPTY_LOAD, NOW, 90)).toBeNull();
  });
  it('AC-8 keeps botRulings true', () => {
    expect(parseCapabilities({ ...capabilities, botRulings: true })).toEqual({ ...capabilities, botRulings: true });
  });
  it.each(['yes', false, null, 1])('AC-9 rejects botRulings %s', (botRulings) => {
    expect(() => parseCapabilities({ ...capabilities, botRulings })).toThrow();
  });
  it.each([undefined, null, { notSent: 'head-unreadable' as const }, { notSent: 'pr-not-open' as const }, { headSha: snapshot.headSha, rulings: [] }])(
    'AC-10 preserves the ordinary placement shape for %j', (prRulings) => {
      expect(toPlacementJob({ ...fix, prRulings }, repo)).toEqual({
        command: 'FIX', repoId: fix.repoId, projectId: repo.projectId, provider: repo.provider,
        profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw',
      });
      expect(buildAssignPayload({ ...fix, prRulings }, repo, 'https://x/y.git', identity).review).not.toHaveProperty('rulings');
    },
  );
  it('keeps bot_rulings recoverable and exposes its dashboard reason', () => {
    expect([...PERMANENT_MISFITS]).not.toContain('bot_rulings');
    expect(MISFIT_REASONS).toContain('bot_rulings');
    expect(parseCapabilities(capabilities)).not.toHaveProperty('botRulings');
  });
});
