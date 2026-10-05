import type { StoryRow } from '~/lib/fleet-jobs'

/** `from` is the dependency, `to` the story that waits on it. */
export interface StoryEdge {
  from: string
  to: string
}

export interface UnresolvedDep {
  story: string
  dep: string
  reason: 'unknown' | 'cycle'
}

export interface StoryGraphLayout {
  /** Column 0 holds the roots. */
  columns: StoryRow[][]
  edges: StoryEdge[]
  unresolved: UnresolvedDep[]
}

const edgeKey = (story: string, dep: string): string => `${story}\u0000${dep}`

interface Frame {
  id: string
  next: number
}

/**
 * D430: an iterative DFS in PRD order. A dependency that is still on the stack closes a cycle; that back edge is cut
 * and reported. A story's column is fixed when it leaves the stack, after all its remaining dependencies did.
 */
function assignColumns(
  stories: readonly StoryRow[],
  depsOf: ReadonlyMap<string, readonly string[]>,
): { columnOf: Map<string, number>; cut: Set<string>; cycles: UnresolvedDep[] } {
  const state = new Map<string, 'open' | 'done'>()
  const columnOf = new Map<string, number>()
  const cut = new Set<string>()
  const cycles: UnresolvedDep[] = []
  for (const root of stories) {
    if (state.has(root.id)) continue
    const stack: Frame[] = [{ id: root.id, next: 0 }]
    state.set(root.id, 'open')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const deps = depsOf.get(frame.id) ?? []
      if (frame.next < deps.length) {
        const dep = deps[frame.next]
        stack[stack.length - 1] = { id: frame.id, next: frame.next + 1 }
        const seen = state.get(dep)
        if (seen === 'open') {
          cut.add(edgeKey(frame.id, dep))
          cycles.push({ story: frame.id, dep, reason: 'cycle' })
        }
        else if (seen === undefined) {
          state.set(dep, 'open')
          stack.push({ id: dep, next: 0 })
        }
        continue
      }
      stack.pop()
      state.set(frame.id, 'done')
      const depColumns = deps.filter(dep => !cut.has(edgeKey(frame.id, dep))).map(dep => columnOf.get(dep) ?? 0)
      columnOf.set(frame.id, depColumns.length === 0 ? 0 : 1 + Math.max(...depColumns))
    }
  }
  return { columnOf, cut, cycles }
}

/** D430: longest-path layering, then one barycentre pass per column, left to right. Never throws. */
export function layoutStoryGraph(rows: readonly StoryRow[]): StoryGraphLayout {
  const byId = new Map<string, StoryRow>()
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  const stories = [...byId.values()]
  const prdIndex = new Map(stories.map((story, index) => [story.id, index]))
  const depsOf = new Map(stories.map(story => [story.id, story.dependsOn.filter(dep => byId.has(dep))]))
  const unknown: UnresolvedDep[] = stories.flatMap(story =>
    story.dependsOn.filter(dep => !byId.has(dep)).map(dep => ({ story: story.id, dep, reason: 'unknown' as const })))

  const { columnOf, cut, cycles } = assignColumns(stories, depsOf)
  const liveDeps = (id: string): string[] => (depsOf.get(id) ?? []).filter(dep => !cut.has(edgeKey(id, dep)))
  const edges = stories.flatMap(story => liveDeps(story.id).map(dep => ({ from: dep, to: story.id })))

  const width = stories.length === 0 ? 0 : 1 + Math.max(...stories.map(story => columnOf.get(story.id) ?? 0))
  const layered = Array.from({ length: width }, (_, column) => stories.filter(story => columnOf.get(story.id) === column))
  const columns = layered.reduce<StoryRow[][]>((placed, column) => {
    if (placed.length === 0) return [column]
    const position = new Map(placed.flatMap(col => col.map((story, index) => [story.id, index] as const)))
    const weight = (story: StoryRow): number => {
      const positions = liveDeps(story.id).map(dep => position.get(dep) ?? 0)
      return positions.length === 0 ? 0 : positions.reduce((sum, p) => sum + p, 0) / positions.length
    }
    const order = (story: StoryRow): number => prdIndex.get(story.id) ?? 0
    return [...placed, [...column].sort((a, b) => weight(a) - weight(b) || order(a) - order(b))]
  }, [])

  return { columns, edges, unresolved: [...unknown, ...cycles] }
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface EdgePath extends StoryEdge {
  d: string
}

const round = (n: number): number => Math.round(n * 10) / 10

/** A cubic from the dependency's right middle to the dependent's left middle; bends by at least 24 px. */
export function edgePath(from: Box, to: Box): string {
  const sx = from.x + from.width
  const sy = from.y + from.height / 2
  const ex = to.x
  const ey = to.y + to.height / 2
  const dx = Math.max(24, (ex - sx) / 2)
  return `M ${round(sx)} ${round(sy)} C ${round(sx + dx)} ${round(sy)}, ${round(ex - dx)} ${round(ey)}, ${round(ex)} ${round(ey)}`
}

/** D431: only edges whose two ends were measured; a story that left the layout draws nothing. */
export function edgePaths(edges: readonly StoryEdge[], boxes: Readonly<Record<string, Box>>): EdgePath[] {
  return edges.flatMap((edge) => {
    const from = boxes[edge.from]
    const to = boxes[edge.to]
    return from && to ? [{ ...edge, d: edgePath(from, to) }] : []
  })
}

/** The focused or hovered story with its direct dependencies and dependents; null when nothing is active. */
export function neighbourhood(edges: readonly StoryEdge[], activeId: string | null): ReadonlySet<string> | null {
  if (activeId === null) return null
  const linked = edges.flatMap((edge) => {
    if (edge.from === activeId) return [edge.to]
    if (edge.to === activeId) return [edge.from]
    return []
  })
  return new Set([activeId, ...linked])
}
