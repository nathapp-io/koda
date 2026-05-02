import type {
  CreateTicketFromIssueResult,
  MergedPrTransitionInput,
} from '../prisma-vcs.repository';

export const VCS_REPOSITORY = Symbol('VCS_REPOSITORY');

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
