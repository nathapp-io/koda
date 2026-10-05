import { afterEach, describe, test, expect } from '@jest/globals'
import { initialStoryView, readStoryView, STORY_VIEW_KEY, wideViewport, writeStoryView } from '~/lib/fleet-story-view'

type Patch = Record<string, unknown>
const originals = new Map<string, PropertyDescriptor | undefined>()

/** Replaces a global for one test; afterEach restores the exact original descriptor. */
function setGlobal(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Patch)[name]
  }
  originals.clear()
})

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}
const throwingStorage = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceededError') },
}

describe('story view persistence (D432)', () => {
  test('reads only the two known values', () => {
    setGlobal('localStorage', memoryStorage({ [STORY_VIEW_KEY]: 'list' }))
    expect(readStoryView()).toBe('list')
    setGlobal('localStorage', memoryStorage({ [STORY_VIEW_KEY]: 'kanban' }))
    expect(readStoryView()).toBeNull()
  })

  test('writes under koda.fleet.storyView', () => {
    const storage = memoryStorage()
    setGlobal('localStorage', storage)
    writeStoryView('graph')
    expect(storage.data.get('koda.fleet.storyView')).toBe('graph')
  })

  test('throwing or missing storage is ignored', () => {
    setGlobal('localStorage', throwingStorage)
    expect(readStoryView()).toBeNull()
    expect(() => writeStoryView('list')).not.toThrow()
    setGlobal('localStorage', undefined)
    expect(readStoryView()).toBeNull()
  })

  test('wideViewport asks the md media query; null without matchMedia', () => {
    const queries: string[] = []
    setGlobal('matchMedia', (q: string) => { queries.push(q); return { matches: true } })
    expect(wideViewport()).toBe(true)
    expect(queries).toEqual(['(min-width: 768px)'])
    setGlobal('matchMedia', undefined)
    expect(wideViewport()).toBeNull()
    setGlobal('matchMedia', () => { throw new Error('boom') })
    expect(wideViewport()).toBeNull()
  })

  test('initial view: stored choice, else by width, else undecided', () => {
    expect(initialStoryView('list', true)).toBe('list')
    expect(initialStoryView(null, true)).toBe('graph')
    expect(initialStoryView(null, false)).toBe('list')
    expect(initialStoryView(null, null)).toBeNull()
  })
})
