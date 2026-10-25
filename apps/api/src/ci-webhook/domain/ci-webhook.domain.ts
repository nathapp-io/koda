export const CI_WEBHOOK_REPOSITORY = Symbol('CI_WEBHOOK_REPOSITORY');

/**
 * Permissions P2 US-006: runs inside the ticket-number attempt's transaction, after the insert, so the
 * audit entry commits or rolls back with the ticket. A rejection is not a number conflict, so the
 * attempt is not retried.
 */
export type OnCiTicketCreated = (ticket: { id: string; number: number }) => Promise<void>;

export interface CiTicketDomain {
  id: string;
  projectId: string;
  number: number;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  gitRefVersion: string | null;
  gitRefFile: string | null;
  gitRefLine: number | null;
}

export interface CiProjectDomain {
  id: string;
  key: string;
  deletedAt: Date | null;
  ciWebhookToken: string | null;
}
