/**
 * Track 1 Slice 5: the live (SSE) proxy core. Kept free of Nitro auto-import
 * globals so unit tests can import it directly.
 *
 * Unlike the catch-all proxyRequest, this aborts the upstream request when the
 * browser goes away, so a closed tab releases its API stream (and the user's
 * per-user stream slot) at once.
 */
import { resolveProxyTarget } from './proxy-target'

// Same rule as the API's CreateProjectDto slug.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const LIVE_STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
})

export interface LiveProxyRequest {
  slug: string
  cookie: string | undefined
  apiInternalUrl: string
  onClientClose: (cb: () => void) => void
  fetchImpl?: typeof fetch
}

export type LiveProxyResult =
  | { kind: 'stream'; body: ReadableStream<Uint8Array> }
  | { kind: 'error'; status: number; body: string }

export function buildLiveUpstreamUrl(slug: string, apiInternalUrl: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return null
  return resolveProxyTarget(`/projects/${slug}/events`, { apiInternalUrl })
}

export async function openLiveUpstream(req: LiveProxyRequest): Promise<LiveProxyResult> {
  const url = buildLiveUpstreamUrl(req.slug, req.apiInternalUrl)
  if (!url) return { kind: 'error', status: 400, body: 'invalid project slug' }

  const controller = new AbortController()
  req.onClientClose(() => controller.abort())
  const headers: Record<string, string> = req.cookie
    ? { accept: 'text/event-stream', cookie: req.cookie }
    : { accept: 'text/event-stream' }

  let upstream: Response
  try {
    upstream = await (req.fetchImpl ?? fetch)(url, { headers, signal: controller.signal })
  }
  catch {
    return { kind: 'error', status: 502, body: 'live upstream unavailable' }
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '')
    return { kind: 'error', status: upstream.ok ? 502 : upstream.status, body }
  }
  return { kind: 'stream', body: upstream.body }
}
