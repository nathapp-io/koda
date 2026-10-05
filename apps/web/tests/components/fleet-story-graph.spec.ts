import { describe, test, expect } from '@jest/globals'
import { nextTick } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { layoutStoryGraph } from '~/lib/fleet-story-graph'
import type { StoryRow } from '~/lib/fleet-jobs'

const file = webFile('components', 'fleet', 'story-graph', 'StoryGraph.vue')
const row = (id: string, dependsOn: string[] = [], over: Partial<StoryRow> = {}): StoryRow => ({
  id, title: `Title ${id}`, status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn, ...over,
})
const diamond = [
  row('US-001', [], { status: 'passed', variant: 'default', attempts: 1 }),
  row('US-002', ['US-001'], { status: 'in-progress', variant: 'secondary', current: true, phase: 'implement', attempts: 2 }),
  row('US-003', ['US-001']),
  row('US-004', ['US-002', 'US-003', 'US-999']),
  row('US-005'),
]
const mount = (rows: StoryRow[] = diamond) =>
  mountSfc(file, { props: { layout: layoutStoryGraph(rows) }, globals: { useI18n: enI18n }, components: uiStubs })
const nodes = (app: ReturnType<typeof mount>) => app.find('[data-testid="fleet-story-node"]')
const nodeOf = (app: ReturnType<typeof mount>, id: string) => {
  const found = nodes(app).find(n => n.props['data-story'] === id)
  if (!found) throw new Error(`no node ${id}`)
  return found
}

describe('StoryGraph (spec §2.2)', () => {
  test('one column per layer, in layout order', () => {
    const app = mount()
    expect(nodes(app).map(n => [n.props['data-story'], n.props['data-column']])).toEqual([
      ['US-001', '0'], ['US-005', '0'], ['US-002', '1'], ['US-003', '1'], ['US-004', '2'],
    ])
    expect(app.find('ol').map(ol => ol.props['aria-label'])).toEqual(['Step 1', 'Step 2', 'Step 3'])
    app.unmount()
  })

  test('the container scrolls horizontally on its own and is labelled', () => {
    const app = mount()
    const root = app.one('[data-testid="fleet-story-graph"]')
    expect(String(root?.props.class)).toContain('overflow-x-auto')
    expect(root?.props['aria-label']).toBe('Story dependency graph')
    app.unmount()
  })

  test('a node shows id, title, translated status, attempts and, when current, the phase', () => {
    const app = mount()
    const current = nodeOf(app, 'US-002')
    expect(current).toBeDefined()
    const text = app.textOf(current)
    for (const part of ['US-002', 'Title US-002', 'In progress', 'Attempts: 2', 'Now: implement']) expect(text).toContain(part)
    expect(current.props['data-current']).toBe('true')
    expect(current.props['aria-current']).toBe('step')
    expect(current.props['data-status']).toBe('in-progress')
    expect(nodeOf(app, 'US-003').props['aria-current']).toBeUndefined()
    expect(app.find('[data-testid="fleet-story-node-phase"]')).toHaveLength(1)
    app.unmount()
  })

  test('nodes are focusable and their label names status and dependencies (D446)', () => {
    const app = mount()
    expect(nodeOf(app, 'US-004').props.tabindex).toBe('0')
    expect(nodeOf(app, 'US-004').props['aria-label']).toBe('US-004 Title US-004. Pending. Depends on US-002, US-003, US-999.')
    expect(nodeOf(app, 'US-001').props['aria-label']).toBe('US-001 Title US-001. Passed. No dependencies.')
    app.unmount()
  })

  test('the full title is kept in the title attribute for the 2-line clamp', () => {
    const app = mount()
    const title = app.find('p', nodeOf(app, 'US-003')).find(p => String(p.props.class).includes('line-clamp-2'))
    expect(title?.props.title).toBe('Title US-003')
    app.unmount()
  })

  test('unknown and cyclic dependencies are called out on the node, not drawn', () => {
    const app = mount([...diamond, row('US-006', ['US-007']), row('US-007', ['US-006'])])
    // DFS from US-006 cuts US-007 -> US-006; US-007 lands in column 0, so its note renders before US-004's.
    const notes = app.find('[data-testid="fleet-story-node-note"]')
    expect(notes.map(n => [n.props['data-reason'], app.textOf(n)])).toEqual([
      ['cycle', 'Depends on US-006 (cycle, not drawn)'],
      ['unknown', 'Depends on US-999 (not shown)'],
    ])
    app.unmount()
  })

  test('without a DOM no edges are drawn (D431)', () => {
    const app = mount()
    expect(app.find('[data-testid="fleet-story-edge"]')).toHaveLength(0)
    expect(app.find('svg')).toHaveLength(0)
    app.unmount()
  })

  test('focusing a node keeps its neighbours and dims the rest; blur clears it', async () => {
    const app = mount()
    expect(nodes(app).map(n => n.props['data-emphasis'])).toEqual(['normal', 'normal', 'normal', 'normal', 'normal'])
    ;(nodeOf(app, 'US-002').props.onFocus as () => void)()
    await nextTick()
    expect(Object.fromEntries(nodes(app).map(n => [n.props['data-story'], n.props['data-emphasis']]))).toEqual({
      'US-001': 'active', 'US-002': 'active', 'US-003': 'dim', 'US-004': 'active', 'US-005': 'dim',
    })
    ;(nodeOf(app, 'US-002').props.onBlur as () => void)()
    await nextTick()
    expect(nodes(app).every(n => n.props['data-emphasis'] === 'normal')).toBe(true)
    app.unmount()
  })

  test('hover works like focus', async () => {
    const app = mount()
    ;(nodeOf(app, 'US-005').props.onMouseenter as () => void)()
    await nextTick()
    expect(nodeOf(app, 'US-001').props['data-emphasis']).toBe('dim')
    ;(nodeOf(app, 'US-005').props.onMouseleave as () => void)()
    await nextTick()
    expect(nodeOf(app, 'US-001').props['data-emphasis']).toBe('normal')
    app.unmount()
  })
})
