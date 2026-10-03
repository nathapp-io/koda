import { createProjectEventStream } from '~/lib/project-event-stream'
import type { ProjectEventHandlers, ProjectEventStreamDeps } from '~/lib/project-event-stream'

/** One subscription; its identity (not the handlers object) is what unsubscribe removes. */
interface Entry {
  handlers: ProjectEventHandlers
}

export interface ProjectEventHub {
  /** Returns the unsubscribe; calling it more than once is a no-op. */
  subscribe: (url: string, handlers: ProjectEventHandlers) => () => void
}

/**
 * D246: one EventSource per URL, shared by every subscriber in the tab (a page and the header badge). The fan-out
 * handlers define every event type, so the stream listens for all of them; each subscriber gets the ones it handles.
 * A stream that gave up (MAX_TERMINAL_FAILURES) stays registered until its last subscriber leaves, so a later
 * subscriber on the same page shares the dead stream and relies on its own poll, exactly as a lone page did before.
 */
export function createProjectEventHub(deps: ProjectEventStreamDeps): ProjectEventHub {
  let entries: ReadonlyMap<string, readonly Entry[]> = new Map()
  let streams: ReadonlyMap<string, { close: () => void }> = new Map()

  const current = (url: string): readonly Entry[] => entries.get(url) ?? []

  const fanOut = (url: string): ProjectEventHandlers => ({
    onEvent: (event) => { for (const e of current(url)) e.handlers.onEvent?.(event) },
    onFleetJob: (event) => { for (const e of current(url)) e.handlers.onFleetJob?.(event) },
    onFleetApproval: (event) => { for (const e of current(url)) e.handlers.onFleetApproval?.(event) },
    onResync: () => { for (const e of current(url)) e.handlers.onResync() },
  })

  function subscribe(url: string, handlers: ProjectEventHandlers): () => void {
    const entry: Entry = { handlers }
    entries = new Map([...entries, [url, [...current(url), entry]]])
    if (!streams.has(url)) streams = new Map([...streams, [url, createProjectEventStream(url, fanOut(url), deps)]])

    let active = true
    return () => {
      if (!active) return
      active = false
      const rest = current(url).filter((e) => e !== entry)
      if (rest.length > 0) {
        entries = new Map([...entries, [url, rest]])
        return
      }
      entries = new Map([...entries].filter(([key]) => key !== url))
      streams.get(url)?.close()
      streams = new Map([...streams].filter(([key]) => key !== url))
    }
  }

  return { subscribe }
}
