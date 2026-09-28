/** M10: GitHub's default page is 30 items; ask for the maximum. */
export const ISSUES_PER_PAGE = 100;

/** M10: pages fetched per poll. A capped poll resumes from its cursor on the next tick. */
export const MAX_ISSUE_PAGES = 10;

/** The rel="next" URL from a GitHub `Link` header, or null. */
export function nextLinkUrl(linkHeader: string | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

/** GitLab's `X-Next-Page` header as a page number; empty or invalid means no next page. */
export function nextPageNumber(header: string | undefined): number | null {
  const page = Number.parseInt(header ?? '', 10);
  return Number.isInteger(page) && page > 0 ? page : null;
}

/** The later of `current` and the ISO timestamp `iso`; unparseable input keeps `current`. */
export function laterOf(current: Date | null, iso: string | null | undefined): Date | null {
  if (!iso) return current;
  const candidate = new Date(iso);
  if (Number.isNaN(candidate.getTime())) return current;
  return !current || candidate > current ? candidate : current;
}

/** Whether `url` is on the same origin as `base`. A pagination link that is not never receives the token. */
export function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
