import type { VcsConnectionDomain, VcsConnectionWithProjectDomain, VcsSyncLogDomain, VcsTicketDomain } from './vcs.domain';

export const VCS_REPOSITORY = Symbol('VCS_REPOSITORY');

export interface MergedPrTransitionInput {
  ticketId: string;
  externalRef: string | null;
  prUrl: string;
  mergedBy: string | null;
  mergeSha: string | null;
}

export interface CreateTicketFromIssueResult {
  id: string;
  number: number;
  title: string;
}

export interface TicketLinkData {
  id: string;
  ticketId: string;
  prNumber: number | null;
  prState: string | null;
  url: string;
  externalRef: string | null;
  ticket?: {
    id: string;
    status: string;
    projectId: string;
    number: number;
    externalVcsId: string | null;
  };
}

export interface CreateVcsConnectionData {
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  encryptedToken: string;
  syncMode: string;
  allowedAuthors: string;
  pollingIntervalMs: number;
  webhookSecret: string | null;
  isActive: boolean;
}

export interface UpdateVcsConnectionData {
  encryptedToken?: string;
  syncMode?: string;
  allowedAuthors?: string;
  pollingIntervalMs?: number;
  webhookSecret?: string | null;
  lastSyncedAt?: Date;
}

export interface CreateVcsSyncLogData {
  vcsConnectionId: string;
  syncType: string;
  issuesSynced: number;
  issuesSkipped: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt: Date;
}

export interface OutboxDedupQuery {
  projectId: string;
  eventType: string;
  eventId: string;
  statuses: string[];
  since: Date;
}

export interface IVcsRepository {
  // Ticket + Issue operations
  findExistingTicketByExternalId(projectId: string, externalVcsId: string): Promise<VcsTicketDomain | null>;
  createTicketFromIssue(project: { id: string }, issue: { number: number; title: string; body: string | null }): Promise<CreateTicketFromIssueResult>;

  // TicketLink operations
  findActiveTicketLinksWithPrs(projectId: string): Promise<TicketLinkData[]>;
  findTicketLinkByPrNumber(projectId: string, prNumber: number): Promise<TicketLinkData | null>;
  updateTicketLinkPrState(id: string, prState: string): Promise<void>;
  updateTicketLinkWithPrState(id: string, prState: string): Promise<void>;

  // Merged PR auto-transition
  applyMergedPrTransition(input: MergedPrTransitionInput): Promise<void>;

  // Ticket lookup (for webhook synchronize handler)
  findTicketWithProject(ticketId: string): Promise<{ id: string; number: number; externalVcsId: string | null; project: { id: string; key: string } } | null>;

  // VcsConnection operations
  findProjectById(projectId: string): Promise<{ id: string } | null>;
  findVcsConnectionByProjectId(projectId: string): Promise<VcsConnectionDomain | null>;
  findVcsConnectionById(connectionId: string): Promise<VcsConnectionWithProjectDomain | null>;
  findPollingConnections(): Promise<VcsConnectionWithProjectDomain[]>;
  createVcsConnection(data: CreateVcsConnectionData): Promise<VcsConnectionDomain>;
  updateVcsConnection(projectId: string, data: UpdateVcsConnectionData): Promise<VcsConnectionDomain>;
  updateVcsConnectionLastSynced(connectionId: string): Promise<void>;
  deleteVcsConnection(projectId: string): Promise<void>;

  // VcsSyncLog operations
  createVcsSyncLog(data: CreateVcsSyncLogData): Promise<VcsSyncLogDomain>;

  // Outbox dedup (cross-instance push deduplication)
  findPendingOutboxEvents(query: OutboxDedupQuery): Promise<{ id: string }[]>;
}
