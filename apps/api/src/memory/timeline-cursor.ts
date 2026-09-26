export interface TimelineKey {
  createdAt: Date;
  id: string;
}

const SEPARATOR = '|';
// Anchored ISO-8601 UTC timestamp as produced by Date#toISOString().
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeTimelineCursor(key: TimelineKey): string {
  return Buffer.from(`${key.createdAt.toISOString()}${SEPARATOR}${key.id}`, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeTimelineCursor(cursor: string): TimelineKey | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = decoded.indexOf(SEPARATOR);
  if (at < 0) return null;
  const iso = decoded.slice(0, at);
  const id = decoded.slice(at + 1);
  if (!ISO_UTC.test(iso) || id.length === 0) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, id };
}

/** `where AND (createdAt, id) < cursor`, without clobbering a createdAt range in `where`. */
export function keysetWhere(
  where: Record<string, unknown>,
  cursor: TimelineKey | undefined,
): Record<string, unknown> {
  if (!cursor) return where;
  return {
    AND: [
      where,
      { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] },
    ],
  };
}
