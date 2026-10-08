/**
 * Fleet S4a §4: the signed-in user's notification stream. More specific than server/api/[...].ts, so Nitro routes
 * it here instead of proxyRequest. A refused upstream (401, 429 stream cap) passes its status through, which makes the
 * browser EventSource stop instead of retrying blindly; the bell then relies on its 60 s poll.
 */
import { buildUserLiveUpstreamUrl, LIVE_STREAM_HEADERS, openLiveUpstreamUrl } from '../../utils/live-proxy'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const result = await openLiveUpstreamUrl(buildUserLiveUpstreamUrl(String(config.apiInternalUrl ?? '')), {
    cookie: getRequestHeader(event, 'cookie'),
    // Response 'close' = the browser connection went away (see the project events route).
    onClientClose: cb => event.node.res.on('close', cb),
  })
  if (result.kind === 'error') {
    setResponseStatus(event, result.status)
    setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    return result.body
  }
  setResponseHeaders(event, { ...LIVE_STREAM_HEADERS })
  return sendStream(event, result.body).catch(() => undefined)
})
