/**
 * Fleet S5b 2b1 (2b1-D8): the two input helpers the write tools share with `koda_add_comment`. They were private to
 * `action-tools.ts` until the write group needed them; behaviour is unchanged by the move.
 */

/** The input as a record; a missing key, a null and a non-object body all read as absent fields. */
export function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** What every result names a ticket by: the web path a human can open. */
export const ticketPath = (slug: string, ref: string): string => `/${slug}/tickets/${ref}`;
