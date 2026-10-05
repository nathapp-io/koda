import { afterEach, describe, test, expect } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '../../lib/fleet-types'

const file = webFile('components', 'fleet', 'story-graph', 'FleetJobPipeline.vue')
const base = {
  command: 'RUN', state: 'RUNNING', currentStoryId: 'US-002', currentPhase: 'implement', storiesTruncated: false,
  postRun: { acceptance: 'running' },
  stories: [
    { id: 'US-001', title: 'Login form', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Session cookie', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
  ],
} as unknown as FleetJobDto

const originals = new Map<string, PropertyDescriptor | undefined>()
function setGlobal(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originals.clear()
})
const wide = (matches: boolean) => setGlobal('matchMedia', () => ({ matches }))
const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

const mount = async (over: Partial<FleetJobDto> = {}) => {
  const app = mountSfc(file, { props: { job: { ...base, ...over } }, globals: { useI18n: enI18n }, components: uiStubs })
  await nextTick()
  return app
}
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}
const the = (app: Awaited<ReturnType<typeof mount>>, id: string) => must(app.one(`[data-testid="${id}"]`), id)
const has = (app: Awaited<ReturnType<typeof mount>>, id: string): boolean => app.find(`[data-testid="${id}"]`).length > 0
const click = async (app: Awaited<ReturnType<typeof mount>>, id: string): Promise<void> => {
  (the(app, id).props.onClick as () => void)()
  await nextTick()
}

describe('FleetJobPipeline (spec §2.2, D440-D443)', () => {
  test('no story rows: the whole section is hidden', async () => {
    const app = await mount({ stories: null })
    expect(has(app, 'fleet-job-pipeline')).toBe(false)
    app.unmount()
  })

  test('one heading for both views', async () => {
    wide(true)
    const app = await mount()
    expect(app.find('h2').map(h => app.textOf(h))).toEqual(['Stories'])
    app.unmount()
  })

  test('RUN jobs get the four-stage strip; PLAN jobs none', async () => {
    wide(true)
    const run = await mount()
    expect(run.find('[data-testid="fleet-pipeline-stage"]').map(s => [s.props['data-stage'], s.props['data-state']])).toEqual([
      ['stories', 'running'], ['acceptance', 'running'], ['regression', 'pending'], ['finish', 'pending'],
    ])
    expect(run.textOf(the(run, 'fleet-pipeline-strip'))).toContain('Acceptance')
    run.unmount()
    const plan = await mount({ command: 'PLAN' })
    expect(has(plan, 'fleet-pipeline-strip')).toBe(false)
    expect(has(plan, 'fleet-story-graph')).toBe(true)
    plan.unmount()
  })

  test('an unknown stage value is shown raw', async () => {
    wide(true)
    const app = await mount({ postRun: { finish: 'half-done' } })
    const finish = app.find('[data-testid="fleet-pipeline-stage"]').find(s => s.props['data-stage'] === 'finish')
    expect(app.textOf(must(finish, 'finish stage'))).toContain('half-done')
    app.unmount()
  })

  test('wide viewport defaults to Graph, narrow to List (D441)', async () => {
    wide(true)
    const graph = await mount()
    expect([has(graph, 'fleet-story-graph'), has(graph, 'fleet-job-stories')]).toEqual([true, false])
    expect(the(graph, 'fleet-story-view-graph').props['aria-pressed']).toBe(true)
    graph.unmount()
    wide(false)
    const list = await mount()
    expect([has(list, 'fleet-story-graph'), has(list, 'fleet-job-stories')]).toEqual([false, true])
    expect(the(list, 'fleet-story-view-list').props['aria-pressed']).toBe(true)
    list.unmount()
  })

  test('before the viewport is known both views render and CSS picks one (SSR, D441)', async () => {
    const app = await mount()
    expect(String(the(app, 'fleet-story-graph').props.class)).toContain('hidden md:block')
    expect(String(the(app, 'fleet-job-stories').props.class)).toContain('md:hidden')
    app.unmount()
  })

  test('the stored choice beats the viewport', async () => {
    wide(true)
    setGlobal('localStorage', memoryStorage({ 'koda.fleet.storyView': 'list' }))
    const app = await mount()
    expect([has(app, 'fleet-story-graph'), has(app, 'fleet-job-stories')]).toEqual([false, true])
    app.unmount()
  })

  test('clicking the toggle switches the view and remembers it', async () => {
    wide(true)
    const storage = memoryStorage()
    setGlobal('localStorage', storage)
    const app = await mount()
    await click(app, 'fleet-story-view-list')
    expect([has(app, 'fleet-story-graph'), has(app, 'fleet-job-stories')]).toEqual([false, true])
    expect(storage.data.get('koda.fleet.storyView')).toBe('list')
    await click(app, 'fleet-story-view-graph')
    expect([has(app, 'fleet-story-graph'), has(app, 'fleet-job-stories')]).toEqual([true, false])
    expect(storage.data.get('koda.fleet.storyView')).toBe('graph')
    app.unmount()
  })

  test('throwing storage: the toggle still works (Review Focus)', async () => {
    wide(true)
    setGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    })
    const app = await mount()
    expect(has(app, 'fleet-story-graph')).toBe(true)
    await click(app, 'fleet-story-view-list')
    expect(has(app, 'fleet-job-stories')).toBe(true)
    app.unmount()
  })

  test('the toggle is a labelled button group (D440)', async () => {
    wide(true)
    const app = await mount()
    const group = the(app, 'fleet-story-view-toggle')
    expect([group.props.role, group.props['aria-label']]).toEqual(['group', 'Story view'])
    app.unmount()
  })

  test('the truncation note shows only when the list was cut, in either view', async () => {
    wide(true)
    const plain = await mount()
    expect(has(plain, 'fleet-job-stories-truncated')).toBe(false)
    plain.unmount()
    const cut = await mount({ storiesTruncated: true })
    expect(cut.textOf(the(cut, 'fleet-job-stories-truncated'))).toContain('first 2 stories')
    cut.unmount()
  })
})
