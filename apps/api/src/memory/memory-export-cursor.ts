/**
 * The export feed's keyset position (memory-notes US-006).
 *
 * A mirror of a project's memory asks for every row that changed after the last row it stored, so the
 * position has to be the same pair the feed is ordered by — `(updatedAt, id)`, never the id alone: a row
 * superseded, retired or soft-deleted keeps its id but gets a new `updatedAt`, and that is exactly the
 * change a mirror has to replay.
 *
 * The wire shape is the one `timeline-cursor.ts` already puts in a query string: the base64url of
 * `iso|id`, an ISO-8601 UTC millisecond timestamp and the row id. It is opaque to clients and strict on
 * the way back in — anything this module did not produce (garbage, a missing separator, a timestamp that
 * `Date#toISOString()` would not write) decodes to null, so the route can answer 400 instead of silently
 * replaying the feed from the beginning.
 */
export interface MemoryExportKey {
  updatedAt: Date;
  id: string;
}

const SEPARATOR = '|';
// Anchored ISO-8601 UTC timestamp as produced by Date#toISOString().
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeMemoryExportCursor(key: MemoryExportKey): string {
  return Buffer.from(`${key.updatedAt.toISOString()}${SEPARATOR}${key.id}`, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeMemoryExportCursor(cursor: string): MemoryExportKey | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // The id may itself contain a separator, so only the first one splits the pair.
  const at = decoded.indexOf(SEPARATOR);
  if (at < 0) return null;
  const iso = decoded.slice(0, at);
  const id = decoded.slice(at + 1);
  if (!ISO_UTC.test(iso) || id.length === 0) return null;
  const updatedAt = new Date(iso);
  if (Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== iso) return null;
  return { updatedAt, id };
}
