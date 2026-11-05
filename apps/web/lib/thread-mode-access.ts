/**
 * thread-agents-modes US-012 (fix round 1, F1): which execution profiles a viewer may switch a thread to.
 *
 * The web only decides what to show; the API decides what it allows. This mirrors the API's own rule
 * (`ThreadsService.changeMode` + `PrismaChatThreadRepository.changeMode`), because a gate that is stricter than the
 * API hides a permitted action and one that is looser offers a refused one:
 *
 * 1. the TARGET mode's key is checked with the thread as the resource, so an any-row grant works for anybody and an
 *    `.own` grant only on a thread the caller created (`thread.cap.update` and `thread.answer` are the catalog keys with
 *    an `own` scope; `thread.mode.ask` / `thread.mode.full` have none);
 * 2. the caller must then be the thread's creator or hold ANY-ROW `thread.cap.update`.
 *
 * The default developer's role grants `thread.cap.update.own` + `thread.mode.ask`, so an any-row-only check would
 * hide Read from the creator whose thread it is.
 */
import type { PermissionSet } from '~/lib/permissions'
import type { ThreadMode } from '~/lib/thread-types'

/** The catalog key each mode change gates on (`apps/api/src/fleet/threads/thread-mode.ts` `threadModeKey`). */
export const THREAD_MODE_PERMISSION_KEYS: Record<ThreadMode, string> = {
  read: 'thread.cap.update',
  ask: 'thread.mode.ask',
  full: 'thread.mode.full',
}

/** Display order of the control; the values match the API's `ThreadMode`. */
export const THREAD_MODES: ThreadMode[] = ['read', 'ask', 'full']

/** The any-row authority an operator needs to change somebody else's thread's mode. */
export const THREAD_OPERATE_KEY = 'thread.cap.update'

/**
 * The modes this viewer may switch the thread to, in display order.
 *
 * `isCreator` is the answer to "did I create this thread", which is the resource the API checks the target key against.
 */
export function allowedThreadModes(
  permissions: Pick<PermissionSet, 'has' | 'hasOwn'>,
  isCreator: boolean,
): ThreadMode[] {
  const canOperate = isCreator || permissions.has(THREAD_OPERATE_KEY)
  if (!canOperate) return []
  return THREAD_MODES.filter((mode) => {
    const key = THREAD_MODE_PERMISSION_KEYS[mode]
    return permissions.has(key) || (isCreator && permissions.hasOwn(key))
  })
}
