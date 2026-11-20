/**
 * K17: the logs page's Download control hands the browser a URL, and the browser's own request for it never carries
 * an expired access token — the Nuxt `/api` proxy refreshes `text/html` requests only (`server/utils/session-refresh.ts`),
 * so a stream download behind an expired access cookie answers 401 although the refresh cookie is still valid.
 *
 * Renaming the session before navigating fixes that: `probe` is one ordinary `$api` GET, which refreshes and retries
 * once on a 401 (`useApi` M22), and only a resolved probe reaches `open`.
 */
export interface LogDownloadDeps {
  /** Renews the session; the page passes `logsApi.list()`, whose 401 retry refreshes the cookies. */
  probe: () => Promise<unknown>
  /** Starts the download itself: the page creates an anchor with `href` and `download` and clicks it. */
  open: (href: string) => void
}

/** Await the probe, then start the download. A rejected probe rejects this and never calls `open`. */
export async function startLogDownload(href: string, deps: LogDownloadDeps): Promise<void> {
  await deps.probe()
  deps.open(href)
}
