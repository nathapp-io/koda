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
  createdAt: Date;
}
