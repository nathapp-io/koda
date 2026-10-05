import { HomeService } from './home.service';
import type { IHomeRepository } from './home.domain';
import { HOME_LIMITS, type HomeApprovalRow, type HomeJobRow, type HomeProjectRow } from './home.types';

const NOW = new Date('2026-10-06T12:00:00Z');
const SINCE = new Date(NOW.getTime() - 7 * 86_400_000);

const project = (over: Partial<HomeProjectRow> = {}): HomeProjectRow => ({
  id: 'p1', name: 'Web', key: 'WEB', slug: 'web', description: null, ...over,
});

const approval = (over: Partial<HomeApprovalRow> = {}): HomeApprovalRow => ({
  id: 'a1', type: 'nax_bash_escalate', projectId: 'p1', jobId: 'j1', requestedAt: NOW, expiresAt: null, ...over,
});

const job = (over: Partial<HomeJobRow> = {}): HomeJobRow => ({
  id: 'j1', projectId: 'p1', feature: 'f', command: 'RUN', state: 'FAILED', stateReason: null, costSpentUsd: '0',
  resultPrUrl: null, queuedAt: NOW, finishedAt: NOW, project: { slug: 'web' }, ...over,
});

function fakeRepo(over: Partial<IHomeRepository> = {}): jest.Mocked<IHomeRepository> {
  return {
    findProjects: jest.fn().mockResolvedValue([project()]),
    findMyTickets: jest.fn().mockResolvedValue([]),
    countMyTickets: jest.fn().mockResolvedValue(0),
    findPendingApprovals: jest.fn().mockResolvedValue([]),
    countPendingApprovals: jest.fn().mockResolvedValue(0),
    findFailedJobs: jest.fn().mockResolvedValue([]),
    countFailedJobs: jest.fn().mockResolvedValue(0),
    findBlockedJobs: jest.fn().mockResolvedValue([]),
    countBlockedJobs: jest.fn().mockResolvedValue(0),
    countOpenTicketsByProject: jest.fn().mockResolvedValue(new Map()),
    countAttentionJobsByProject: jest.fn().mockResolvedValue(new Map()),
    findRecentActivity: jest.fn().mockResolvedValue({ ticketEvents: [], agentEvents: [], decisionEvents: [] }),
    ...over,
  } as jest.Mocked<IHomeRepository>;
}

describe('HomeService', () => {
  it('scopes reads to the caller: member projects for a user, unscoped approvals only for a global admin', async () => {
    const member = fakeRepo();
    await new HomeService(member).snapshot({ id: 'u1', globalAdmin: false }, NOW);
    expect(member.findProjects).toHaveBeenCalledWith({ id: 'u1', globalAdmin: false });
    expect(member.findPendingApprovals).toHaveBeenCalledWith({ projectIds: ['p1'], includeUnscoped: false }, HOME_LIMITS.pendingScan);
    expect(member.findMyTickets).toHaveBeenCalledWith('u1', ['p1'], HOME_LIMITS.tickets);
    expect(member.findFailedJobs).toHaveBeenCalledWith(['p1'], SINCE, HOME_LIMITS.jobs);

    const admin = fakeRepo({ findProjects: jest.fn().mockResolvedValue([]) });
    await new HomeService(admin).snapshot({ id: 'u1', globalAdmin: true }, NOW);
    expect(admin.findPendingApprovals).toHaveBeenCalledWith({ projectIds: [], includeUnscoped: true }, HOME_LIMITS.pendingScan);
  });

  it('looks up blocked jobs from the pending approvals of the first wave and counts attention per project with them', async () => {
    const repo = fakeRepo({
      findPendingApprovals: jest.fn().mockResolvedValue([approval({ jobId: 'j1' }), approval({ id: 'a2', jobId: 'j1' }), approval({ id: 'a3', jobId: null })]),
      findBlockedJobs: jest.fn().mockResolvedValue([job({ id: 'j1', state: 'QUEUED', finishedAt: null })]),
    });
    const v = await new HomeService(repo).snapshot({ id: 'u1', globalAdmin: false }, NOW);
    expect(repo.findBlockedJobs).toHaveBeenCalledWith(['j1'], HOME_LIMITS.jobs);
    expect(repo.countBlockedJobs).toHaveBeenCalledWith(['j1']);
    expect(repo.countAttentionJobsByProject).toHaveBeenCalledWith(['p1'], SINCE, ['j1']);
    expect(v.needsYou.jobs).toEqual([expect.objectContaining({ id: 'j1', reason: 'blocked', pendingApprovals: 2 })]);
  });

  it('never issues a blocked-jobs read when nothing is pending', async () => {
    const repo = fakeRepo();
    await new HomeService(repo).snapshot({ id: 'u1', globalAdmin: false }, NOW);
    expect(repo.findBlockedJobs).toHaveBeenCalledWith([], HOME_LIMITS.jobs);
    expect(repo.countAttentionJobsByProject).toHaveBeenCalledWith(['p1'], SINCE, []);
  });
});
