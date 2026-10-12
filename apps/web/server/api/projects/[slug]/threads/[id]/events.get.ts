/**
 * Fleet S5a: browser live-updates stream for one thread. More specific than
 * server/api/[...].ts, so Nitro routes it there instead of proxyRequest:
 * an invalid slug or thread id is answered 400 without touching the API, and
 * a non-200 upstream answer is passed through with its status (the browser
 * EventSource then stops, readyState CLOSED, instead of retrying blindly).
 */
import { LIVE_STREAM_HEADERS, openThreadLiveUpstream } from '../../../../../utils/live-proxy'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const result = await openThreadLiveUpstream({
    slug: getRouterParam(event, 'slug') ?? '',
    threadId: getRouterParam(event, 'id') ?? '',
    cookie: getRequestHeader(event, 'cookie'),
    apiInternalUrl: String(config.apiInternalUrl ?? ''),
    // Response 'close' = the browser connection went away. Request 'close'
    // fires as soon as a bodiless GET has been read, so it must not be used.
    onClientClose: cb => event.node.res.on('close', cb),
  })
  if (result.kind === 'error') {
    setResponseStatus(event, result.status)
    setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    return result.body
  }
  setResponseHeaders(event, { ...LIVE_STREAM_HEADERS })
  // A browser disconnect aborts the upstream, which errors the piped body;
  // that is the normal end of a live stream, not a request error.
  return sendStream(event, result.body).catch(() => undefined)
})