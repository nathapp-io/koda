/**
 * thread-agents-modes US-007: the session approvals a thread is waiting on, as the ingest fold keeps them in
 * `ChatThread.pendingApprovals` and the thread DTO answers them.
 *
 * The list is bounded and ordered: a request is appended after the ones already listed and the oldest twenty are kept,
 * so a session that asks more than twenty times still waits for every request but the page lists the first twenty.
 * List operations answer `null` when nothing would change, so the fold can skip a write (an empty Prisma update fails).
 */

/** At most this many pending approvals are listed per thread; a later request is dropped from the list. */
export const MAX_PENDING_APPROVALS = 20;

/**
 * The field bounds a pending approval has to fit, shared by the line parser and the column reader so a stored entry is
 * always readable back. A `summary` past its bound makes the line incomplete (it never becomes pending), because the
 * page could not show what the request would do.
 */
export const PENDING_APPROVAL_LIMITS = { tool: 128, summary: 4096, command: 8192, reason: 2048 } as const;

/** One answerable approval a thread waits on: the tool, what it would do, and when it stops waiting. */
export interface ThreadPendingApproval {
  requestId: string;
  tool: string;
  summary: string;
  command?: string;
  reason?: string;
  /** When the runner stops waiting for the decision (ISO 8601). */
  expiresAt: string;
  /** Set when the request would leave the session's sandbox. */
  unsandboxed?: true;
}

const isNonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;

const isIsoDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** One stored entry, or null when the column holds something this version cannot read. */
function toEntry(value: unknown): ThreadPendingApproval | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { tool, summary, command, reason } = PENDING_APPROVAL_LIMITS;
  if (!isNonEmptyString(row.requestId, 128) || !isNonEmptyString(row.tool, tool) || !isNonEmptyString(row.summary, summary) || !isIsoDate(row.expiresAt)) return null;
  return {
    requestId: row.requestId, tool: row.tool, summary: row.summary, expiresAt: row.expiresAt,
    ...(isNonEmptyString(row.command, command) ? { command: row.command } : {}),
    ...(isNonEmptyString(row.reason, reason) ? { reason: row.reason } : {}),
    ...(row.unsandboxed === true ? { unsandboxed: true as const } : {}),
  };
}

/** The stored column as its entries: an absent or unreadable column is a thread with nothing pending. */
export function readPendingApprovals(json: unknown): ThreadPendingApproval[] {
  if (!Array.isArray(json)) return [];
  return json.map(toEntry).filter((entry): entry is ThreadPendingApproval => entry !== null);
}

/** The list with `entry` appended last, honoring the cap; null when nothing would change. */
export function appendPendingApproval(
  current: readonly ThreadPendingApproval[],
  entry: ThreadPendingApproval,
): ThreadPendingApproval[] | null {
  // A replayed line (a boot catch-up fold) must not list the same request twice.
  if (current.some((row) => row.requestId === entry.requestId)) return null;
  if (current.length >= MAX_PENDING_APPROVALS) return null;
  return [...current, entry];
}

/** The list without the request `requestId` names; null when it is not listed. */
export function removePendingApproval(
  current: readonly ThreadPendingApproval[],
  requestId: string,
): ThreadPendingApproval[] | null {
  if (!current.some((row) => row.requestId === requestId)) return null;
  return current.filter((row) => row.requestId !== requestId);
}
