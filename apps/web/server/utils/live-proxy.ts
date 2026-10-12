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

export function buildUserLiveUpstreamUrl(apiInternalUrl: string): string {
  return resolveProxyTarget('/me/events', { apiInternalUrl })
}

// Same rule as the API's clientMessageId format (SendMessageDto).
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Fleet S5a: the API thread events URL; null for an invalid slug or thread id. */
export function buildThreadLiveUpstreamUrl(slug: string, threadId: string, apiInternalUrl: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return null
  if (!THREAD_ID_PATTERN.test(threadId)) return null
  return resolveProxyTarget(`/projects/${slug}/threads/${threadId}/events`, { apiInternalUrl })
}

export type ThreadLiveUpstreamRequest = LiveProxyRequest & { threadId: string }

/** Fleet S5a: thread events proxy core; rejects an invalid slug or thread id with 400 before fetching. */
export async function openThreadLiveUpstream(req: ThreadLiveUpstreamRequest): Promise<LiveProxyResult> {
  const url = buildThreadLiveUpstreamUrl(req.slug, req.threadId, req.apiInternalUrl)
  if (!url) return { kind: 'error', status: 400, body: 'invalid thread id' }
  return openLiveUpstreamUrl(url, req)
}

export type LiveUpstreamRequest = Omit<LiveProxyRequest, 'slug' | 'apiInternalUrl'>

export async function openLiveUpstream(req: LiveProxyRequest): Promise<LiveProxyResult> {
  const url = buildLiveUpstreamUrl(req.slug, req.apiInternalUrl)
  if (!url) return { kind: 'error', status: 400, body: 'invalid project slug' }
  return openLiveUpstreamUrl(url, req)
}

/** S4a §4: the shared core for the project and the user (`/me/events`) streams. */
export async function openLiveUpstreamUrl(url: string, req: LiveUpstreamRequest): Promise<LiveProxyResult> {
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
