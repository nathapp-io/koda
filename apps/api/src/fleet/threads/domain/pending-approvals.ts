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

/** The `delivery.detail` bound: the sync already slices an ack detail to 200, kept here so a stored entry stays readable. */
export const APPROVAL_DELIVERY_DETAIL_MAX = 200;

/**
 * B3 (whole-branch review): what the runner answered for the last decision sent for one request. A `200` from the
 * decision route only means the command was queued, so the page cannot know from it whether the session took the
 * decision; the ack does, and it is kept on the request it decided.
 */
export interface ThreadApprovalDelivery {
  /** Which way the last decision went. */
  decision: 'allow' | 'deny';
  /** `ok` = the session accepted it; `rejected` = the runner refused it and the request is still pending. */
  result: 'ok' | 'rejected';
  /** The runner's own reason for a rejection; null when it gave none. */
  detail: string | null;
  /** When the runner acknowledged the command (ISO 8601). */
  at: string;
}

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
  /** The runner's outcome for the last decision sent for this request; absent until one is acknowledged. */
  delivery?: ThreadApprovalDelivery;
}

const isNonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;

const isIsoDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** One stored delivery, or null when the column holds something this version cannot read (the entry itself stands). */
function toDelivery(value: unknown): ThreadApprovalDelivery | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.decision !== 'allow' && row.decision !== 'deny') return null;
  if (row.result !== 'ok' && row.result !== 'rejected') return null;
  if (!isIsoDate(row.at)) return null;
  if (row.detail !== null && row.detail !== undefined && !isNonEmptyString(row.detail, APPROVAL_DELIVERY_DETAIL_MAX)) return null;
  const detail = isNonEmptyString(row.detail, APPROVAL_DELIVERY_DETAIL_MAX) ? row.detail : null;
  return { decision: row.decision, result: row.result, detail, at: row.at };
}

/** One stored entry, or null when the column holds something this version cannot read. */
function toEntry(value: unknown): ThreadPendingApproval | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { tool, summary, command, reason } = PENDING_APPROVAL_LIMITS;
  if (!isNonEmptyString(row.requestId, 128) || !isNonEmptyString(row.tool, tool) || !isNonEmptyString(row.summary, summary) || !isIsoDate(row.expiresAt)) return null;
  const delivery = toDelivery(row.delivery);
  return {
    requestId: row.requestId, tool: row.tool, summary: row.summary, expiresAt: row.expiresAt,
    ...(isNonEmptyString(row.command, command) ? { command: row.command } : {}),
    ...(isNonEmptyString(row.reason, reason) ? { reason: row.reason } : {}),
    ...(row.unsandboxed === true ? { unsandboxed: true as const } : {}),
    ...(delivery ? { delivery } : {}),
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

/**
 * The list with `delivery` recorded on the request it decided; null when that request is no longer listed (the session
 * already resolved it, so there is nothing left to explain) or when it already holds this very outcome.
 *
 * B3: a rejection keeps the entry — the runner refused the decision, so the session is still waiting and the page must
 * offer the decision again — and the delivery is what tells the page it was refused.
 */
export function setApprovalDelivery(
  current: readonly ThreadPendingApproval[],
  requestId: string,
  delivery: ThreadApprovalDelivery,
): ThreadPendingApproval[] | null {
  const index = current.findIndex((row) => row.requestId === requestId);
  if (index < 0) return null;
  const entry = current[index] as ThreadPendingApproval;
  const before = entry.delivery;
  if (
    before !== undefined && before.decision === delivery.decision && before.result === delivery.result
    && before.detail === delivery.detail && before.at === delivery.at
  ) return null;
  const next = [...current];
  next[index] = { ...entry, delivery };
  return next;
}
