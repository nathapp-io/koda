/**
 * Review B2 — the classic auto-PR's link retry.
 *
 * `createPrForTicket` runs after the VERIFIED transition has committed, so a forge PR that was created (or adopted)
 * whose `TicketLink` write then failed leaves the ticket VERIFIED with no link. The workflow has no route back into
 * VERIFIED, and nothing else re-runs that post-commit work, so the link would be lost for good.
 *
 * The failed link write is therefore recorded on the outbox: the row is durable (it survives this process) and the
 * relay redelivers it until the subscriber's handler links the PR. The handler re-runs the same branch lookup, so it
 * adopts the open PR the forge already has instead of opening a second one.
 */
export const TICKET_PR_LINK_RETRY = 'ticket_pr_link_retry';

export interface TicketPrLinkRetryPayload {
  projectId: string;
  /** The key `buildBranchName` needs; stored with the payload so the retry reads no project row of its own. */
  projectKey: string;
  ticketId: string;
}

/** The recorded payload for one failed link write. */
export function ticketPrLinkRetryPayload(
  project: { id: string; key: string },
  ticketId: string,
): TicketPrLinkRetryPayload {
  return { projectId: project.id, projectKey: project.key, ticketId };
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Reads a delivered payload; null when it is not this event's shape (a stray record is skipped, never fatal). */
export function parseTicketPrLinkRetryPayload(payload: unknown): TicketPrLinkRetryPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { projectId, projectKey, ticketId } = payload as Record<string, unknown>;
  if (!nonEmpty(projectId) || !nonEmpty(projectKey) || !nonEmpty(ticketId)) return null;
  return { projectId, projectKey, ticketId };
}
