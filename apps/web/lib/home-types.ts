/**
 * Shapes of `GET /home` (apps/api/src/home) — the cross-project dashboard snapshot.
 * Kept mirroring the API DTOs; the API owns the aggregation, the web only renders it.
 */

export interface HomeTicket {
  id: string
  projectId: string
  projectSlug: string
  ref: string
  title: string
  type: string
  status: string
  priority: string
  updatedAt: string
}

export interface HomeApproval {
  id: string
  type: string
  projectId: string | null
  projectSlug: string | null
  jobId: string | null
  requestedAt: string
  expiresAt: string | null
}

export interface HomeJob {
  id: string
  projectId: string
  projectSlug: string
  feature: string
  command: string
  state: string
  stateReason: string | null
  pendingApprovals: number
  costSpentUsd: string
  resultPrUrl: string | null
  queuedAt: string
  finishedAt: string | null
  reason: 'failed' | 'blocked'
}

export interface HomeProject {
  id: string
  name: string
  key: string
  slug: string
  description: string | null
  openTickets: number
  attentionJobs: number
}

export interface HomeActivity {
  id: string
  eventType: 'ticket_event' | 'agent_event' | 'decision_event'
  projectSlug: string
  action: string
  actorId: string
  ticketId: string | null
  createdAt: string
}

export interface HomeNeedsYou {
  tickets: HomeTicket[]
  ticketsTotal: number
  approvals: HomeApproval[]
  approvalsTotal: number
  jobs: HomeJob[]
  jobsTotal: number
}

export interface HomeSnapshot {
  generatedAt: string
  needsYou: HomeNeedsYou
  projects: HomeProject[]
  activity: HomeActivity[]
}
