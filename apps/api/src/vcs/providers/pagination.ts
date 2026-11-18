/** M10: GitHub's default page is 30 items; ask for the maximum. */
export const ISSUES_PER_PAGE = 100;

/** M10: pages fetched per poll. A capped poll resumes from its cursor on the next tick. */
export const MAX_ISSUE_PAGES = 10;

/**
 * Review B3: pages the GitLab open-merge-request lookup scans for a same-project request. GitLab pages merge
 * requests in its own order, so a fork's request can fill a page ahead of the same-project one. A scan that
 * reaches this bound is a lookup failure (the caller must not read it as "no open MR"), so the bound is generous
 * but finite.
 */
export const MAX_MR_LOOKUP_PAGES = 10;

/** The rel="next" URL from a GitHub `Link` header, or null. */
export function nextLinkUrl(linkHeader: string | undefined): string | null {
  if (!linkHeader) return null;
  // Commas can also occur inside the target URI or a quoted parameter.
  for (const [, target, params] of linkHeader.matchAll(/(?:^|,)\s*<([^<>]*)>((?:[^<>,"]|"(?:[^"\\]|\\.)*")*)/g)) {
    for (const [, name, quoted, token] of params.matchAll(/;\s*([^\s=;]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+)))?/g)) {
      if (name.toLowerCase() !== 'rel') continue;
      if ((quoted ?? token ?? '').toLowerCase().split(/\s+/).includes('next')) return target;
      break; // Ignore duplicate rel parameters on the same link.
    }
  }
  return null;
}

/**
 * M10: the resume lower bound, backed off by one second. GitHub's `since` and
 * GitLab's `updated_after` filter on an exact boundary; when a poll is capped at
 * MAX_ISSUE_PAGES and more items share the cursor's `updated_at` than fit in the
 * fetched pages, an exclusive filter would skip them on the next tick. Backing
 * the bound off by a second re-fetches the boundary (import dedup skips it) and
 * guarantees nothing is missed.
 */
export function inclusiveSince(cursor: Date): string {
  return new Date(cursor.getTime() - 1000).toISOString();
}

/**
 * Review B3 (fix round 2): the page number a `Link` header advertises for `rel="next"`, or null.
 *
 * GitLab answers `X-Next-Page` on its own pagination, but a proxy in front of it can rewrite the headers so only
 * the standard `Link` header survives. A response that advertises another page is not proof that the branch has no
 * same-project merge request, so the next page is requested from the configured endpoint — never from the URL the
 * header names, so the token never travels to a host the header chose.
 */
export function nextPageFromLink(linkHeader: string | undefined, endpoint: string): number | null {
  const next = nextLinkUrl(linkHeader);
  if (next === null) return null;

  const url = URL.parse(next, endpoint);
  const pages = url?.searchParams.getAll('page');
  const page = pages?.length === 1 ? nextPageNumber(pages[0]) : null;
  if (page === null) throw new Error('Invalid next page in Link header');
  return page;
}

/** Parse a positive decimal page number without accepting partial numbers or overflow. */
export function nextPageNumber(header: string | undefined): number | null {
  const value = header?.trim() ?? '';
  if (!/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
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
