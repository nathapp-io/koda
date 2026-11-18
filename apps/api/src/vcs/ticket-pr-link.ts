/**
 * Review B2 — the classic auto-PR's link retry.
 *
 * `createPrForTicket` runs after the VERIFIED transition has committed, so a forge PR that was created (or adopted)
 * whose `TicketLink` write then failed leaves the ticket VERIFIED with no link. The workflow has no route back into
 * VERIFIED, and nothing else re-runs that post-commit work, so the link would be lost for good.
 *
 * The recovery intent is therefore recorded on the outbox *before* the forge call — where a crash between the PR and
 * its link cannot lose it — and the relay redelivers it until the subscriber's handler links the PR. The payload
 * carries the repository and branch the call targeted: a retry must adopt that branch's PR even after the ticket
 * title (and so `buildBranchName`) or the project's connection changed.
 */
export const TICKET_PR_LINK_RETRY = 'ticket_pr_link_retry';

/** The forge target one classic auto-PR call works on, recorded with its intent. */
export interface TicketPrLinkTarget {
  provider: string;
  repoOwner: string;
  repoName: string;
  branchName: string;
}

export interface TicketPrLinkRetryPayload extends Partial<TicketPrLinkTarget> {
  projectId: string;
  /** The key `buildBranchName` needs; stored with the payload so the retry reads no project row of its own. */
  projectKey: string;
  ticketId: string;
}

/** The recorded payload for one classic auto-PR attempt. */
export function ticketPrLinkRetryPayload(
  project: { id: string; key: string },
  ticketId: string,
  target?: TicketPrLinkTarget,
): TicketPrLinkRetryPayload {
  return {
    projectId: project.id,
    projectKey: project.key,
    ticketId,
    ...(target === undefined
      ? {}
      : {
        provider: target.provider,
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        branchName: target.branchName,
      }),
  };
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Reads a delivered payload; null when it is not this event's shape (a stray record is skipped, never fatal).
 *
 * Review B2 (fix round 2): the target is read only when all four fields are present. A payload recorded before the
 * intent carried a target (a row still queued at deploy time) parses without one, and its retry falls back to the
 * current connection and ticket title rather than failing the delivery.
 */
export function parseTicketPrLinkRetryPayload(payload: unknown): TicketPrLinkRetryPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { projectId, projectKey, ticketId, provider, repoOwner, repoName, branchName } =
    payload as Record<string, unknown>;
  if (!nonEmpty(projectId) || !nonEmpty(projectKey) || !nonEmpty(ticketId)) return null;
  const hasTarget = nonEmpty(provider) && nonEmpty(repoOwner) && nonEmpty(repoName) && nonEmpty(branchName);
  return hasTarget
    ? { projectId, projectKey, ticketId, provider, repoOwner, repoName, branchName }
    : { projectId, projectKey, ticketId, };
}
