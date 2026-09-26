interface Ordered {
  createdAt: Date;
  id: string;
}

/**
 * Newest first; ties broken by id descending. Ids compare by code unit so the
 * in-memory merge agrees with Postgres `ORDER BY "createdAt" DESC, id DESC`
 * for cuids (lowercase alphanumeric).
 */
export function compareEventsDesc(a: Ordered, b: Ordered): number {
  const timeDelta = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}
