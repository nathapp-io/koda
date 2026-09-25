/**
 * Shared ticket-ref parsing used by every surface that resolves a ticket by
 * human ref (KEY-N) or CUID: tickets, transitions, comments and labels.
 *
 * H5: the KEY-N prefix check must exist in exactly one place so that
 * project-scoped resolution cannot drift between call sites.
 */
export const TICKET_REF_PATTERN = /^([A-Z]+)-(\d+)$/;

export interface ParsedTicketRef {
  prefix: string;
  number: number;
}

/**
 * Parse a ticket reference.
 *
 * Returns `{ prefix, number }` for `KEY-N` refs (uppercase prefix, numeric
 * suffix), or `null` when the ref should be treated as a ticket CUID/id.
 */
export function parseTicketRef(ref: string): ParsedTicketRef | null {
  const match = ref.match(TICKET_REF_PATTERN);
  if (!match) return null;
  return { prefix: match[1], number: parseInt(match[2], 10) };
}
