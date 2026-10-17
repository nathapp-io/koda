/**
 * Fleet S5b 2b1 (2b1-D8): the two input helpers the write tools share with `koda_add_comment`. They were private to
 * `action-tools.ts` until the write group needed them; behaviour is unchanged by the move. S5b 2b2 US-001 (2b2-D8)
 * adds `jobPath`, moved out of the fleet read tools unchanged.
 */

/** The input as a record; a missing key, a null and a non-object body all read as absent fields. */
export function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** What every result names a ticket by: the web path a human can open. */
export const ticketPath = (slug: string, ref: string): string => `/${slug}/tickets/${ref}`;

/** What every fleet result names a job by: the web path a human can open. */
export const jobPath = (slug: string, jobId: string): string => `/${slug}/fleet/jobs/${jobId}`;
