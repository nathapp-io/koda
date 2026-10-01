/** What the poller needs from the browser; injected so the timing is testable with fake timers. */
export interface PollingDeps {
  isHidden: () => boolean
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  /** Calls `fn` whenever the tab becomes visible; returns the unsubscribe. */
  onVisible: (fn: () => void) => () => void
}

/** The real browser hooks. Only touched on the client (start runs in onMounted). */
export function browserPollingDeps(): PollingDeps {
  return {
    isHidden: () => document.visibilityState === 'hidden',
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    onVisible: (fn) => {
      const listener = (): void => {
        if (document.visibilityState === 'visible') fn()
      }
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/**
 * Runs `task` every `ms` while the tab is visible (S1 spec §1: the Runners page polls every 15 s).
 * At most one run at a time: a tick or runNow during a run is skipped. A rejected run never stops
 * the polling (the task reports its own errors). The tab becoming visible again runs it at once.
 */
export function useVisiblePolling(task: () => Promise<void>, ms: number, deps: PollingDeps = browserPollingDeps()) {
  let handle: unknown = null
  let unsubscribe: (() => void) | null = null
  let running = false

  async function runNow(): Promise<void> {
    if (running) return
    running = true
    try {
      await task()
    } catch {
      // The task owns its error reporting (toast, stale note); polling carries on.
    } finally {
      running = false
    }
  }

  function tick(): void {
    if (!deps.isHidden()) void runNow()
  }

  function start(): void {
    if (handle !== null) return
    handle = deps.setInterval(tick, ms)
    unsubscribe = deps.onVisible(tick)
  }

  function stop(): void {
    if (handle !== null) deps.clearInterval(handle)
    handle = null
    unsubscribe?.()
    unsubscribe = null
  }

  return { start, stop, runNow, isActive: () => handle !== null }
}
