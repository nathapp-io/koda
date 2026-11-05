import { describe, expect, test } from '@jest/globals'
import { permissionSet } from '~/lib/permissions'
import { allowedThreadModes, THREAD_MODE_PERMISSION_KEYS } from '~/lib/thread-mode-access'

/**
 * thread-agents-modes US-012 (fix round 1, F1): which mode buttons a viewer may use.
 *
 * The API decides this in two parts (`ThreadsService.changeMode` + `PrismaChatThreadRepository.changeMode`):
 * the TARGET key is checked with the thread as the resource (`permissions.can(key, { resource: { createdBy } })`), so an
 * `.own` grant counts only on a thread the caller created; and the caller must then be the thread's creator OR hold an
 * ANY-ROW `thread.cap.update`. Both halves are mirrored here, because a UI that skips the first hides Read from the
 * creator whose role grants `thread.cap.update.own`, and one that skips the second offers mode changes on somebody
 * else's thread.
 */

const allowed = (keys: readonly string[], isCreator: boolean): string[] =>
  allowedThreadModes(permissionSet(keys), isCreator)

describe('US-012 F1: allowedThreadModes', () => {
  test('the gates are the API thread-mode keys, one per mode', () => {
    expect(THREAD_MODE_PERMISSION_KEYS).toEqual({
      read: 'thread.cap.update',
      ask: 'thread.mode.ask',
      full: 'thread.mode.full',
    })
  })

  test("the default developer's own-row grants give the creator Read and Ask, never Full", () => {
    // thread.cap.update is the only thread-mode key with an `.own` scope; the default developer holds it as own-row.
    expect(allowed(['thread.cap.update.own', 'thread.mode.ask'], true)).toEqual(['read', 'ask'])
  })

  test('a creator holding every key of the three modes may use all three', () => {
    expect(allowed(['thread.cap.update', 'thread.mode.ask', 'thread.mode.full'], true)).toEqual(['read', 'ask', 'full'])
  })

  test('a creator with only the own-row cap key may switch back to Read and nothing else', () => {
    expect(allowed(['thread.cap.update.own'], true)).toEqual(['read'])
  })

  test('a creator holding no thread key at all gets no mode', () => {
    expect(allowed([], true)).toEqual([])
  })

  test("another creator's thread offers nothing without the any-row thread.cap.update authority", () => {
    // thread.mode.ask alone is not enough: the viewer is not the creator and does not operate threads in this project.
    expect(allowed(['thread.mode.ask'], false)).toEqual([])
    expect(allowed(['thread.mode.ask', 'thread.cap.update.own'], false)).toEqual([])
  })

  test('the any-row cap authority plus a mode key offers that mode on a thread the viewer did not create', () => {
    expect(allowed(['thread.cap.update', 'thread.mode.ask'], false)).toEqual(['read', 'ask'])
    expect(allowed(['thread.cap.update'], false)).toEqual(['read'])
  })

  test('an own-row mode key never unlocks another creator’s thread', () => {
    expect(allowed(['thread.cap.update', 'thread.mode.full.own'], false)).toEqual(['read'])
  })
})
