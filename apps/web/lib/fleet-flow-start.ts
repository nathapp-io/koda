import type { ThreadDto } from '~/lib/thread-types'

export const FLOW_SPEC_PATH_RE = /^\.nax\/features\/([^/]+)\/spec\.md$/

export interface FlowStartRow {
  feature: string
  specPath: string
  dependsOn: string[]
}

export function flowStartRows(thread: ThreadDto): FlowStartRow[] {
  const rows: FlowStartRow[] = []
  const seen = new Set<string>()

  if (thread.feature !== null && thread.specPath !== null) {
    rows.push({ feature: thread.feature, specPath: thread.specPath, dependsOn: [] })
    seen.add(thread.feature)
  }

  if (thread.lastWrite?.kind === 'published') {
    for (const path of thread.lastWrite.paths) {
      const match = FLOW_SPEC_PATH_RE.exec(path)
      const feature = match?.[1]
      if (feature === undefined || seen.has(feature)) continue
      const previous = rows.at(-1)
      rows.push({ feature, specPath: path, dependsOn: previous === undefined ? [] : [previous.feature] })
      seen.add(feature)
    }
  }

  return rows
}

export type FlowStartBlock = 'notPublished' | 'flowLive'

export function flowStartState(
  thread: ThreadDto,
  opts: { canCreate: boolean; liveFlow: boolean },
): { visible: boolean; enabled: boolean; reason: FlowStartBlock | null } {
  const visible = thread.kind === 'REPO' && thread.archivedAt === null && opts.canCreate
  if (!visible) return { visible: false, enabled: false, reason: null }
  if (!thread.specPublished || thread.publishedSha === null) {
    return { visible: true, enabled: false, reason: 'notPublished' }
  }
  if (opts.liveFlow) return { visible: true, enabled: false, reason: 'flowLive' }
  return { visible: true, enabled: true, reason: null }
}
