/**
 * M16: `metadata.createdAtOverride` lets a caller backdate a KB record. Only a
 * value that `Date.parse` understands is accepted, normalised to ISO-8601;
 * anything else is reported back so the caller can log it, and the record
 * gets the current time. A bad value must never reach recency scoring.
 */
export function resolveCreatedAt(
  metadata: Record<string, unknown> | undefined,
  now: () => Date = () => new Date(),
): { createdAt: string; rejectedOverride?: unknown } {
  if (!metadata || !('createdAtOverride' in metadata)) {
    return { createdAt: now().toISOString() };
  }
  const override = metadata['createdAtOverride'];
  if (typeof override === 'string') {
    const ms = Date.parse(override);
    if (Number.isFinite(ms)) {
      return { createdAt: new Date(ms).toISOString() };
    }
  }
  return { createdAt: now().toISOString(), rejectedOverride: override };
}
