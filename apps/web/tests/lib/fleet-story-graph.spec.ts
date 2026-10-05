import { describe, test, expect } from '@jest/globals'
import { edgePath, edgePaths, layoutStoryGraph, neighbourhood } from '~/lib/fleet-story-graph'
import type { StoryRow } from '~/lib/fleet-jobs'

const row = (id: string, dependsOn: string[] = []): StoryRow => ({
  id, title: id, status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn,
})
const ids = (columns: StoryRow[][]): string[][] => columns.map(column => column.map(r => r.id))

describe('layoutStoryGraph (D430)', () => {
  test('no rows give an empty layout', () => {
    expect(layoutStoryGraph([])).toEqual({ columns: [], edges: [], unresolved: [] })
  })

  test('linear chain: one story per column', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['B'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B'], ['C']])
    expect(layout.edges).toEqual([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])
    expect(layout.unresolved).toEqual([])
  })

  test('diamond and isolated roots: column = 1 + deepest dependency', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A']), row('D', ['B', 'C']), row('E')])
    expect(ids(layout.columns)).toEqual([['A', 'E'], ['B', 'C'], ['D']])
    expect(layout.edges).toHaveLength(4)
  })

  test('a story sits right of its DEEPEST dependency, not its first', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A', 'B'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B'], ['C']])
  })

  test('fan-in and fan-out', () => {
    expect(ids(layoutStoryGraph([row('A'), row('B'), row('C'), row('D', ['A', 'B', 'C'])]).columns)).toEqual([['A', 'B', 'C'], ['D']])
    expect(ids(layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A']), row('D', ['A'])]).columns)).toEqual([['A'], ['B', 'C', 'D']])
  })

  test('a dependency on an unknown id is reported, not drawn', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A', 'GONE'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B']])
    expect(layout.edges).toEqual([{ from: 'A', to: 'B' }])
    expect(layout.unresolved).toEqual([{ story: 'B', dep: 'GONE', reason: 'unknown' }])
  })

  test('a 2-cycle is broken at the back edge and every story still renders', () => {
    const layout = layoutStoryGraph([row('A', ['B']), row('B', ['A'])])
    expect(layout.columns.flat().map(r => r.id).sort()).toEqual(['A', 'B'])
    expect(layout.edges).toHaveLength(1)
    expect(layout.unresolved).toEqual([{ story: 'B', dep: 'A', reason: 'cycle' }])
  })

  test('a 3-cycle is broken once', () => {
    const layout = layoutStoryGraph([row('A', ['C']), row('B', ['A']), row('C', ['B'])])
    expect(layout.columns.flat()).toHaveLength(3)
    expect(layout.edges).toHaveLength(2)
    expect(layout.unresolved.filter(u => u.reason === 'cycle')).toHaveLength(1)
  })

  test('a self-loop that reaches the layout is treated as a cycle', () => {
    const layout = layoutStoryGraph([row('A', ['A'])])
    expect(ids(layout.columns)).toEqual([['A']])
    expect(layout.edges).toEqual([])
    expect(layout.unresolved).toEqual([{ story: 'A', dep: 'A', reason: 'cycle' }])
  })

  test('duplicate ids: the first occurrence wins', () => {
    const first = { ...row('A'), title: 'first' }
    const layout = layoutStoryGraph([first, { ...row('A'), title: 'second' }, row('B', ['A'])])
    expect(layout.columns.flat().map(r => r.title)).toEqual(['first', 'B'])
  })

  test('barycentre: a column is ordered by the mean position of its dependencies', () => {
    // PRD order puts C (depends on B) before D (depends on A); A sits above B, so D goes first.
    const layout = layoutStoryGraph([row('A'), row('B'), row('C', ['B']), row('D', ['A'])])
    expect(ids(layout.columns)).toEqual([['A', 'B'], ['D', 'C']])
  })

  test('barycentre ties keep PRD order', () => {
    expect(ids(layoutStoryGraph([row('A'), row('C', ['A']), row('B', ['A'])]).columns)).toEqual([['A'], ['C', 'B']])
  })

  test('the input rows are not mutated', () => {
    const rows = [row('A', ['B']), row('B', ['A'])]
    const before = JSON.stringify(rows)
    layoutStoryGraph(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })

  test('100 stories x 10 dependencies lay out well under 5 ms (median of 20 runs)', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(`US-${i}`, Array.from({ length: Math.min(i, 10) }, (_, k) => `US-${i - k - 1}`)))
    const times = Array.from({ length: 20 }, () => {
      const start = performance.now()
      layoutStoryGraph(rows)
      return performance.now() - start
    }).sort((a, b) => a - b)
    expect(times[10]).toBeLessThan(5)
    expect(layoutStoryGraph(rows).columns).toHaveLength(100)
  })
})

describe('edge geometry (D431, D444)', () => {
  const a = { x: 0, y: 0, width: 100, height: 40 }
  const b = { x: 200, y: 60, width: 100, height: 40 }

  test('a cubic from the right middle of the dependency to the left middle of the dependent', () => {
    expect(edgePath(a, b)).toBe('M 100 20 C 150 20, 150 80, 200 80')
  })

  test('close columns still bend by at least 24 px', () => {
    expect(edgePath(a, { x: 120, y: 0, width: 100, height: 40 })).toBe('M 100 20 C 124 20, 96 20, 120 20')
  })

  test('an edge whose endpoint has no measured box is dropped', () => {
    const paths = edgePaths([{ from: 'A', to: 'B' }, { from: 'A', to: 'GONE' }], { A: a, B: b })
    expect(paths).toEqual([{ from: 'A', to: 'B', d: 'M 100 20 C 150 20, 150 80, 200 80' }])
  })
})

describe('neighbourhood', () => {
  const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'X', to: 'Y' }]

  test('nothing active means no emphasis', () => {
    expect(neighbourhood(edges, null)).toBeNull()
  })

  test('the active story plus its direct dependencies and dependents', () => {
    expect([...(neighbourhood(edges, 'B') ?? [])].sort()).toEqual(['A', 'B', 'C'])
  })
})
