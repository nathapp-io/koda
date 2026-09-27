/** Trailing-edge debouncer: `fn` runs once, `ms` after the last trigger. */
export function createDebouncer(fn: () => void, ms: number): { trigger: () => void; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (handle !== null) clearTimeout(handle)
    handle = null
  }
  return {
    trigger: () => {
      cancel()
      handle = setTimeout(() => {
        handle = null
        fn()
      }, ms)
    },
    cancel,
  }
}
