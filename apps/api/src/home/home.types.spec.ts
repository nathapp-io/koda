import {
  ATTENTION_WINDOW_MS, HOME_LIMITS, buildHomeView, type HomeJobRow, type HomeSnapshotInput,
} from './home.types';

const NOW = new Date('2026-10-06T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const project = (over: Partial<HomeSnapshotInput['projects'][number]> = {}): HomeSnapshotInput['projects'][number] => ({
  id: 'p1', name: 'Web', key: 'WEB', slug: 'web', description: null, ...over,
});

const ticket = (over: Partial<HomeSnapshotInput['tickets'][number]> = {}): HomeSnapshotInput['tickets'][number] => ({
  id: 't1', projectId: 'p1', number: 1, type: 'BUG', title: 'T1', status: 'IN_PROGRESS', priority: 'HIGH',
  updatedAt: daysAgo(1), project: { key: 'WEB', slug: 'web' }, ...over,
});

const approval = (over: Partial<HomeSnapshotInput['approvals'][number]> = {}): HomeSnapshotInput['approvals'][number] => ({
  id: 'a1', type: 'nax_bash_escalate', projectId: 'p1', jobId: 'j1', requestedAt: daysAgo(0), expiresAt: null, ...over,
});

const job = (over: Partial<HomeJobRow> = {}): HomeJobRow => ({
  id: 'j1', projectId: 'p1', feature: 'f', command: 'RUN', state: 'FAILED', stateReason: null, costSpentUsd: '1.5',
  resultPrUrl: null, queuedAt: daysAgo(2), finishedAt: daysAgo(1), project: { slug: 'web' }, ...over,
});

const input = (over: Partial<HomeSnapshotInput> = {}): HomeSnapshotInput => ({
  now: NOW,
  projects: [project()],
  tickets: [],
  ticketsTotal: 0,
  approvals: [],
  approvalsTotal: 0,
  failedJobs: [],
  failedJobsTotal: 0,
  blockedJobs: [],
  blockedJobsTotal: 0,
  openTicketsByProject: new Map(),
  attentionJobsByProject: new Map(),
  activity: { ticketEvents: [], agentEvents: [], decisionEvents: [] },
  ...over,
});

describe('buildHomeView', () => {
  it('builds ticket refs from the project key and keeps the exact totals behind the caps', () => {
    const v = buildHomeView(input({
      tickets: [ticket({ number: 12 }), ticket({ id: 't2', number: 13 })],
      ticketsTotal: 30,
      approvalsTotal: 4,
      failedJobsTotal: 2,
      blockedJobsTotal: 3,
    }));
    expect(v.needsYou.tickets.map((t) => t.ref)).toEqual(['WEB-12', 'WEB-13']);
    expect(v.needsYou.ticketsTotal).toBe(30);
    expect(v.needsYou.approvalsTotal).toBe(4);
    expect(v.needsYou.jobsTotal).toBe(5); // failed + blocked, not the listed length
  });

  it('caps every list at the limits', () => {
    const v = buildHomeView(input({
      tickets: Array.from({ length: 12 }, (_, i) => ticket({ id: `t${i}`, number: i + 1 })),
      approvals: Array.from({ length: 12 }, (_, i) => approval({ id: `a${i}`, jobId: null })),
      failedJobs: Array.from({ length: 12 }, (_, i) => job({ id: `j${i}`, finishedAt: daysAgo(1 + i / 48) })),
      activity: {
        ticketEvents: Array.from({ length: 12 }, (_, i) => ({
          id: `te${i}`, projectId: 'p1', eventType: 'ticket_event' as const, action: 'CREATED',
          actorId: 'u1', ticketId: 't1', createdAt: daysAgo(i / 24),
        })),
        agentEvents: [],
        decisionEvents: [],
      },
    }));
    expect(v.needsYou.tickets).toHaveLength(HOME_LIMITS.tickets);
    expect(v.needsYou.approvals).toHaveLength(HOME_LIMITS.approvals);
    expect(v.needsYou.jobs).toHaveLength(HOME_LIMITS.jobs);
    expect(v.activity).toHaveLength(HOME_LIMITS.activity);
  });

  it('lists blocked jobs before failed ones, dedupes by id, and counts pending approvals per job', () => {
    const v = buildHomeView(input({
      approvals: [approval({ id: 'a1', jobId: 'j-block' }), approval({ id: 'a2', jobId: 'j-block' }), approval({ id: 'a3', jobId: 'j-gone' })],
      approvalsTotal: 3,
      blockedJobs: [job({ id: 'j-block', state: 'QUEUED', finishedAt: null, queuedAt: daysAgo(3) })],
      blockedJobsTotal: 1,
      failedJobs: [job({ id: 'j-block' }), job({ id: 'j-fail', finishedAt: daysAgo(0.5), queuedAt: daysAgo(1) })],
      failedJobsTotal: 2,
    }));
    expect(v.needsYou.jobs.map((j) => [j.id, j.reason, j.pendingApprovals])).toEqual([
      ['j-block', 'blocked', 2],
      ['j-fail', 'failed', 0],
    ]);
  });

  it('sorts failed jobs without a finishedAt last', () => {
    const v = buildHomeView(input({
      failedJobs: [job({ id: 'j-null', finishedAt: null }), job({ id: 'j-old', finishedAt: daysAgo(2) }), job({ id: 'j-new', finishedAt: daysAgo(0.5) })],
      failedJobsTotal: 3,
    }));
    expect(v.needsYou.jobs.map((j) => j.id)).toEqual(['j-new', 'j-old', 'j-null']);
  });

  it('sorts projects attention-first, then open tickets, then name; counts default to zero', () => {
    const v = buildHomeView(input({
      projects: [
        project({ id: 'p1', name: 'Web', slug: 'web' }),
        project({ id: 'p2', name: 'Api', slug: 'api' }),
        project({ id: 'p3', name: 'Cli', slug: 'cli' }),
      ],
      openTicketsByProject: new Map([['p1', 5], ['p3', 9]]),
      attentionJobsByProject: new Map([['p2', 2]]),
    }));
    expect(v.projects.map((p) => [p.slug, p.openTickets, p.attentionJobs])).toEqual([
      ['api', 0, 2],
      ['cli', 9, 0],
      ['web', 5, 0],
    ]);
  });

  it('merges the three event tables newest first and resolves the project slug', () => {
    const v = buildHomeView(input({
      activity: {
        ticketEvents: [{ id: 'te1', projectId: 'p1', eventType: 'ticket_event', action: 'STATUS_CHANGE', actorId: 'u1', ticketId: 't1', createdAt: daysAgo(2) }],
        agentEvents: [{ id: 'ae1', projectId: 'p1', eventType: 'agent_event', action: 'CODE_INDEXED', actorId: 'ag1', ticketId: null, createdAt: daysAgo(0.1) }],
        decisionEvents: [{ id: 'de1', projectId: 'p1', eventType: 'decision_event', action: 'decided', actorId: 'ag1', ticketId: null, createdAt: daysAgo(1) }],
      },
    }));
    expect(v.activity.map((e) => [e.id, e.projectSlug, e.eventType])).toEqual([
      ['ae1', 'web', 'agent_event'],
      ['de1', 'web', 'decision_event'],
      ['te1', 'web', 'ticket_event'],
    ]);
  });

  it('stamps generatedAt with the server clock used for the attention window', () => {
    const v = buildHomeView(input({}));
    expect(v.generatedAt).toBe(NOW);
    expect(ATTENTION_WINDOW_MS).toBe(7 * 86_400_000);
  });
});
