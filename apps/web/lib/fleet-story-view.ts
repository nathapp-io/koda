/** S2b (j) D432: which view the job page shows; remembered per browser, best effort. */
export type StoryView = 'graph' | 'list'

export const STORY_VIEW_KEY = 'koda.fleet.storyView'
/** Tailwind's `md` breakpoint: Graph from here up, List below (spec §2.2). */
export const WIDE_QUERY = '(min-width: 768px)'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

type BrowserGlobals = { localStorage?: StorageLike; matchMedia?: (query: string) => { matches: boolean } }
const browser = (): BrowserGlobals => globalThis as unknown as BrowserGlobals

export function readStoryView(): StoryView | null {
  try {
    const value = browser().localStorage?.getItem(STORY_VIEW_KEY)
    return value === 'graph' || value === 'list' ? value : null
  }
  catch {
    return null
  }
}

export function writeStoryView(view: StoryView): void {
  try {
    browser().localStorage?.setItem(STORY_VIEW_KEY, view)
  }
  catch {
    // Storage is optional (private mode, blocked site data): the choice lasts for this visit only.
  }
}

/** True at md and wider; null when the environment cannot tell (SSR, tests). */
export function wideViewport(): boolean | null {
  try {
    const matchMedia = browser().matchMedia
    return typeof matchMedia === 'function' ? matchMedia.call(globalThis, WIDE_QUERY).matches : null
  }
  catch {
    return null
  }
}

/** D441: the stored choice wins; otherwise the viewport decides; null leaves the CSS default in place. */
export function initialStoryView(stored: StoryView | null, wide: boolean | null): StoryView | null {
  if (stored !== null) return stored
  if (wide === null) return null
  return wide ? 'graph' : 'list'
}
