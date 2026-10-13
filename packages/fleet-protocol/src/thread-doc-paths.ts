/**
 * Fleet S5a §4: the repo files a thread may write (`write_doc`) and publish. Pure (no I/O); the runner's write and
 * publish paths and the API's review of a thread's docs both use this one rule.
 */
export const THREAD_DOC_LIMITS = { maxFileBytes: 524_288, maxPathChars: 512 } as const;

/** One path segment: no spaces, no shell or glob characters. Case-sensitive. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isBadSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || !SEGMENT_RE.test(segment) || segment.toLowerCase() === '.git';
}

/**
 * True when a thread may write `path`. `feature` is the thread's feature slug. Allowed: `docs/<...>/<name>.md` with at
 * least two segments, or `.nax/features/<feature>/<...>.md` with at least four segments. Every segment must match
 * `SEGMENT_RE`, and no segment may be `.`, `..` or `.git` (any case).
 */
export function isAllowedThreadDocPath(path: string, feature: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > THREAD_DOC_LIMITS.maxPathChars) return false;
  if (path.includes('\\') || path.includes('\u0000') || path.startsWith('/')) return false;
  const parts = path.split('/');
  if (parts.some(isBadSegment)) return false;
  const file = parts[parts.length - 1];
  if (!file.endsWith('.md') || file.length <= '.md'.length) return false;
  if (parts[0] === 'docs' && parts.length >= 2) return true;
  const featurePrefix = ['.nax', 'features', feature];
  return parts.length >= 4 && featurePrefix.every((segment, index) => parts[index] === segment);
}
