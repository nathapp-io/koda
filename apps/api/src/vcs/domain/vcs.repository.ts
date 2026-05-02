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

export interface IVcsRepository {
  findExistingTicketByExternalId(projectId: string, externalVcsId: string): Promise<unknown | null>;
  createTicketFromIssue(project: { id: string }, issue: { number: number; title: string; body: string | null }): Promise<CreateTicketFromIssueResult>;
  findActiveTicketLinksWithPrs(projectId: string): Promise<TicketLinkData[]>;
  updateTicketLinkPrState(id: string, prState: string): Promise<void>;
  applyMergedPrTransition(input: MergedPrTransitionInput): Promise<void>;
}
