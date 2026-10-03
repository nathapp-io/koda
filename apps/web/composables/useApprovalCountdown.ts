import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'

interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const systemTimers: Timers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** D292: a `now` that moves once a second while started. */
export function createCountdownClock(timers: Timers = systemTimers, tickMs = 1000): { now: Ref<Date>; start(): void; stop(): void } {
  const now = ref(new Date())
  let handle: unknown = null
  return {
    now,
    start() {
      if (handle !== null) return
      handle = timers.set(() => { now.value = new Date() }, tickMs)
    },
    stop() {
      if (handle === null) return
      timers.clear(handle)
      handle = null
    },
  }
}

/** D292: approval countdowns; client-only (the timer starts on mount). */
export function useApprovalCountdown(): { now: Ref<Date> } {
  const clock = createCountdownClock()
  onMounted(() => clock.start())
  onBeforeUnmount(() => clock.stop())
  return { now: clock.now }
}
