/**
 * Home dashboard (UX redesign slice 2): one cross-project snapshot for the signed-in user.
 * The API does the aggregation so the web dashboard stays one request (MASTER-PLAN §6 slice 2).
 */

/** Per-section caps; totals are exact regardless of the caps. */
export const HOME_LIMITS = {
  tickets: 8,
  approvals: 8,
  jobs: 8,
  activity: 10,
  /** Pending approvals read for the blocked-jobs lookup; the display list is capped at `approvals`. */
  pendingScan: 200,
  activityScan: 25,
} as const;

/** Failed/escalated/crashed older than this is history, not "needs you". */
export const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const OPEN_TICKET_STATUSES = ['CREATED', 'VERIFIED', 'IN_PROGRESS', 'VERIFY_FIX'] as const;

export const FAILED_JOB_STATES = ['FAILED', 'ESCALATED', 'CRASHED'] as const;
export const ACTIVE_JOB_STATES = ['QUEUED', 'ASSIGNED'] as const;

export interface HomeCaller {
  id: string;
  globalAdmin: boolean;
}

/** Pending approvals in the caller's projects; no-project ones only for a global admin (mirrors /fleet/approval-counts). */
export interface HomeApprovalScope {
  projectIds: string[];
  includeUnscoped: boolean;
}

export interface HomeProjectRow {
  id: string;
  name: string;
  key: string;
  slug: string;
  description: string | null;
}

export interface HomeTicketRow {
  id: string;
  projectId: string;
  number: number;
  type: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date;
  project: { key: string; slug: string };
}

export interface HomeApprovalRow {
  id: string;
  type: string;
  projectId: string | null;
  jobId: string | null;
  requestedAt: Date;
  expiresAt: Date | null;
}

export interface HomeJobRow {
  id: string;
  projectId: string;
  feature: string;
  command: string;
  state: string;
  stateReason: string | null;
  costSpentUsd: string;
  resultPrUrl: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
  project: { slug: string };
}

export interface HomeActivityRow {
  id: string;
  projectId: string;
  eventType: 'ticket_event' | 'agent_event' | 'decision_event';
  action: string;
  actorId: string;
  ticketId: string | null;
  createdAt: Date;
}

export interface HomeTicketView {
  id: string;
  projectId: string;
  projectSlug: string;
  ref: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  updatedAt: Date;
}

export interface HomeApprovalView {
  id: string;
  type: string;
  projectId: string | null;
  projectSlug: string | null;
  jobId: string | null;
  requestedAt: Date;
  expiresAt: Date | null;
}

export interface HomeJobView {
  id: string;
  projectId: string;
  projectSlug: string;
  feature: string;
  command: string;
  state: string;
  stateReason: string | null;
  pendingApprovals: number;
  costSpentUsd: string;
  resultPrUrl: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
  /** Why the job needs you: a pending decision blocks it, or it finished failed. */
  reason: 'failed' | 'blocked';
}

export interface HomeProjectView extends HomeProjectRow {
  openTickets: number;
  attentionJobs: number;
}

export interface HomeActivityView {
  id: string;
  eventType: HomeActivityRow['eventType'];
  projectSlug: string;
  action: string;
  actorId: string;
  ticketId: string | null;
  createdAt: Date;
}

export interface HomeView {
  generatedAt: Date;
  needsYou: {
    tickets: HomeTicketView[];
    ticketsTotal: number;
    approvals: HomeApprovalView[];
    approvalsTotal: number;
    jobs: HomeJobView[];
    jobsTotal: number;
  };
  projects: HomeProjectView[];
  activity: HomeActivityView[];
}

const NEWEST_FIRST = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

const byQueuedDesc = (a: HomeJobRow, b: HomeJobRow): number =>
  b.queuedAt.getTime() - a.queuedAt.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

const byFinishedDesc = (a: HomeJobRow, b: HomeJobRow): number =>
  (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

export interface HomeSnapshotInput {
  now: Date;
  projects: HomeProjectRow[];
  tickets: HomeTicketRow[];
  ticketsTotal: number;
  approvals: HomeApprovalRow[];
  approvalsTotal: number;
  failedJobs: HomeJobRow[];
  failedJobsTotal: number;
  blockedJobs: HomeJobRow[];
  blockedJobsTotal: number;
  openTicketsByProject: Map<string, number>;
  attentionJobsByProject: Map<string, number>;
  activity: {
    ticketEvents: HomeActivityRow[];
    agentEvents: HomeActivityRow[];
    decisionEvents: HomeActivityRow[];
  };
  limits?: Partial<typeof HOME_LIMITS>;
}

/** Pure assembly: capping, ordering and the attention-first project sort. Kept side-effect free for tests. */
export function buildHomeView(input: HomeSnapshotInput): HomeView {
  const limits = { ...HOME_LIMITS, ...input.limits };
  const slugOf = new Map(input.projects.map((p) => [p.id, p.slug]));

  const tickets: HomeTicketView[] = input.tickets.slice(0, limits.tickets).map((t) => ({
    id: t.id,
    projectId: t.projectId,
    projectSlug: t.project.slug,
    ref: `${t.project.key}-${t.number}`,
    title: t.title,
    type: t.type,
    status: t.status,
    priority: t.priority,
    updatedAt: t.updatedAt,
  }));

  const approvals: HomeApprovalView[] = input.approvals.slice(0, limits.approvals).map((a) => ({
    id: a.id,
    type: a.type,
    projectId: a.projectId,
    projectSlug: a.projectId ? slugOf.get(a.projectId) ?? null : null,
    jobId: a.jobId,
    requestedAt: a.requestedAt,
    expiresAt: a.expiresAt,
  }));

  // Blocked jobs first (a human unblocks them), then failures, newest first; a job in both lists shows once.
  const seen = new Set<string>();
  const jobs: HomeJobView[] = [];
  const pendingByJob = new Map<string, number>();
  for (const a of input.approvals) {
    if (a.jobId) pendingByJob.set(a.jobId, (pendingByJob.get(a.jobId) ?? 0) + 1);
  }
  const ranked: Array<{ row: HomeJobRow; reason: 'failed' | 'blocked' }> = [
    ...[...input.blockedJobs].sort(byQueuedDesc).map((j) => ({ row: j, reason: 'blocked' as const })),
    ...[...input.failedJobs].sort(byFinishedDesc).map((j) => ({ row: j, reason: 'failed' as const })),
  ];
  for (const { row, reason } of ranked) {
    if (jobs.length >= limits.jobs) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const j = row;
    jobs.push({
      id: j.id,
      projectId: j.projectId,
      projectSlug: j.project.slug,
      feature: j.feature,
      command: j.command,
      state: j.state,
      stateReason: j.stateReason,
      pendingApprovals: pendingByJob.get(j.id) ?? 0,
      costSpentUsd: j.costSpentUsd,
      resultPrUrl: j.resultPrUrl,
      queuedAt: j.queuedAt,
      finishedAt: j.finishedAt,
      reason,
    });
  }

  const projects: HomeProjectView[] = input.projects
    .map((p) => ({
      ...p,
      openTickets: input.openTicketsByProject.get(p.id) ?? 0,
      attentionJobs: input.attentionJobsByProject.get(p.id) ?? 0,
    }))
    .sort((a, b) => b.attentionJobs - a.attentionJobs || b.openTickets - a.openTickets || a.name.localeCompare(b.name));

  const activity = [...input.activity.ticketEvents, ...input.activity.agentEvents, ...input.activity.decisionEvents]
    .sort(NEWEST_FIRST)
    .slice(0, limits.activity)
    .map((e) => ({
      id: e.id,
      eventType: e.eventType,
      projectSlug: slugOf.get(e.projectId) ?? '',
      action: e.action,
      actorId: e.actorId,
      ticketId: e.ticketId,
      createdAt: e.createdAt,
    }));

  return {
    generatedAt: input.now,
    needsYou: {
      tickets,
      ticketsTotal: input.ticketsTotal,
      approvals,
      approvalsTotal: input.approvalsTotal,
      jobs,
      jobsTotal: input.failedJobsTotal + input.blockedJobsTotal,
    },
    projects,
    activity,
  };
}
