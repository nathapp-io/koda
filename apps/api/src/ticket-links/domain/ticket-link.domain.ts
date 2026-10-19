export const TICKET_LINK_REPOSITORY = Symbol('TICKET_LINK_REPOSITORY');

export interface TicketLinkDomain {
  id: string;
  ticketId: string;
  url: string;
  provider: string;
  externalRef: string | null;
  prState: string | null;
  prNumber: number | null;
  prUpdatedAt: Date | null;
  linkType: string;
  source?: string;
  jobId?: string | null;
  /** Who added the link, compared for `ticket.link.remove.own`. Null for a creatorless link. */
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
}
