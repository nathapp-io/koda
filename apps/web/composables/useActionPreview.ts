/**
 * Fleet S5b 2aw-D10 (US-004): where the inbox panel reads the exact preview it will approve.
 *
 * S5b-R5 says no write runs without a human approving the exact preview, so the panel never guesses it from the
 * approval payload: it re-reads the thread and takes the `preview` of the action that is still PENDING there. An
 * action that has left that list is not approvable, and the panel shows `previewGone` instead.
 */
import { threadApiPath } from '~/lib/fleet-approvals'

/** The fields of a thread detail this loader reads (S5b 2a-D12 `PendingActionDto`). */
interface PendingActionPreview {
  id: string
  preview: string
}

interface ThreadDetailPreview {
  pendingActions?: PendingActionPreview[] | null
}

export interface ActionPreview {
  /**
   * The text of `actionId` on the thread named by `threadPath`, or null when the thread no longer lists that action.
   * Rejects when `threadPath` is not a thread path (so no request is made out of a string we did not understand) and
   * when the read fails or the entry has no readable preview — an unread preview must never enable Approve.
   */
  load: (threadPath: string, actionId: string) => Promise<string | null>
}

export function useActionPreview(): ActionPreview {
  const { $api } = useApi()

  async function load(threadPath: string, actionId: string): Promise<string | null> {
    const path = threadApiPath(threadPath)
    if (path === null) throw new Error(`useActionPreview: "${threadPath}" is not a thread path`)
    const detail = await $api.get<ThreadDetailPreview>(path)
    const entry = (detail.pendingActions ?? []).find((action) => action.id === actionId)
    if (entry === undefined) return null
    if (typeof entry.preview !== 'string') throw new Error('useActionPreview: the action has no readable preview')
    return entry.preview
  }

  return { load }
}
