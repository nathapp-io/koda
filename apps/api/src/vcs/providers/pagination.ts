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

/** The first rel="next" URL from a `Link` header, or null. */
export function nextLinkUrl(linkHeader: string | undefined): string | null {
  for (const target of nextLinkUrls(linkHeader)) return target;
  return null;
}

function* nextLinkUrls(linkHeader: string | undefined): Generator<string, void> {
  if (!linkHeader) return;
  // Commas can also occur inside the target URI or a quoted parameter.
  for (const [, target, params] of linkHeader.matchAll(/(?:^|,)\s*<([^<>]*)>((?:[^<>,"]|"(?:[^"\\]|\\.)*")*)/g)) {
    for (const [, name, quoted, token] of params.matchAll(/;\s*([^\s=;]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+)))?/g)) {
      if (name.toLowerCase() !== 'rel') continue;
      // Review f-acc2bf15: the grammar above accepts backslash escapes, so decode them before comparing —
      // `rel="n\ext"` is the quoted-pair spelling of `next`.
      const relation = quoted === undefined ? (token ?? '') : quoted.replace(/\\(.)/g, '$1');
      if (relation.toLowerCase().split(/\s+/).includes('next')) yield target;
      break; // Ignore duplicate rel parameters on the same link.
    }
  }
  return null;
}

/**
 * Review f-c80d6428: `target` resolved against the request that advertised it, or null when it is not a
 * usable URL. A relative `Link` target is legal (RFC 8288) and stays on the current origin; before this a
 * relative continuation read as cross-origin, so GitHub's issue fetch capped after page one and a manual
 * sync reported a partial import as success.
 */
export function resolveLinkTarget(target: string, base: string): string | null {
  try {
    return new URL(target, base).toString();
  } catch {
    return null;
  }
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

/** Page advertised by `rel="next"`, or null if no next link is present. */
export function nextPageFromLink(linkHeader: string | undefined, endpoint: string): number | null {
  let advertised: number | null = null;
  for (const next of nextLinkUrls(linkHeader)) {
    const pages = URL.parse(next, endpoint)?.searchParams.getAll('page');
    const page = pages?.length === 1 ? nextPageNumber(pages[0]) : null;
    if (page === null || (advertised !== null && advertised !== page)) {
      throw new Error('Invalid next page in Link header');
    }
    advertised = page;
  }
  return advertised;
}

/**
 * Both GitLab continuation headers, when present, must name the immediate next offset page.
 * A blank X-Next-Page is not a page number; proxies can leave only the Link. Return only the
 * validated number so callers always use their configured endpoint, never the link's host or filters.
 */
export function nextGitLabPage(
  headers: Record<string, string> | undefined,
  endpoint: string,
  currentPage: number,
): number | null {
  const next = currentPage + 1;
  const pageHeader = headers?.['x-next-page']?.trim();
  const fromHeader = nextPageNumber(pageHeader);
  if (pageHeader && fromHeader !== next) {
    throw new Error('Invalid next page in X-Next-Page header: expected the next offset page');
  }
  const fromLink = nextPageFromLink(headers?.['link'], endpoint);
  if (fromLink !== null && fromLink !== next) {
    throw new Error('Invalid next page in Link header: expected the next offset page');
  }
  return fromHeader ?? fromLink;
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
