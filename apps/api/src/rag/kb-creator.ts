/**
 * US-006 — who created a knowledge-base row.
 *
 * A KB row's creator is trusted input: the caller passes the principal it authenticated (a `USER` or an `AGENT`),
 * and the write path records it under `kodaCreatedBy` in the row's metadata. A row without that entry has no
 * creator — it belongs to the system (a ticket-indexer or code-graph row), never to whoever wrote it last.
 *
 * This module is deliberately dependency-free: `rag.service.ts` and `vector-store.service.ts` both import it, and
 * neither may pull the other's runtime code into a shared module.
 */

/** The two kinds of principal that can create a KB row. */
export type KbCreatorType = 'USER' | 'AGENT';

/** The creator a KB row records. */
export interface KbCreator {
  type: KbCreatorType;
  id: string;
}

/** Metadata key the KB write path owns and the read path trusts. */
export const KODA_CREATED_BY = 'kodaCreatedBy';

/**
 * Narrows an arbitrary stored `kodaCreatedBy` value to a creator. Anything that is not a `{ type, id }` pair with
 * a known type and a non-empty id is not a creator, so a malformed or legacy value reads as a system row instead
 * of a forged owner.
 */
export function readKbCreator(value: unknown): KbCreator | null {
  if (!value || typeof value !== 'object') return null;

  const { type, id } = value as { type?: unknown; id?: unknown };
  if (type !== 'USER' && type !== 'AGENT') return null;
  if (typeof id !== 'string' || id.length === 0) return null;

  return { type, id };
}
