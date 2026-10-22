import { describe, expect, test } from '@jest/globals'
import { EMPTY_PERMISSIONS, permissionSet } from '~/lib/permissions'

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-1 — a plain key is held exactly when it is listed
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-1: permissionSet holds the keys it is given', () => {
  test('AC-1: a listed key is held and an unlisted one is not', () => {
    const set = permissionSet(['ticket.create'])

    expect(set.has('ticket.create')).toBe(true)
    expect(set.has('ticket.delete')).toBe(false)
  })

  test('AC-1 (edge): an empty list holds nothing', () => {
    const set = permissionSet([])

    expect(set.has('ticket.create')).toBe(false)
    expect(set.hasOwn('ticket.create')).toBe(false)
  })

  test('AC-1 (edge): a prefix of a listed key is not held', () => {
    const set = permissionSet(['ticket.create.own'])

    expect(set.has('ticket')).toBe(false)
    expect(set.has('ticket.create.ow')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-2 — hasOwn promotes `X.own`, has never does
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-2: hasOwn covers both the key and its .own variant', () => {
  test('AC-2: an own-only row is held by hasOwn and not by has', () => {
    const set = permissionSet(['comment.update.own'])

    expect(set.hasOwn('comment.update')).toBe(true)
    expect(set.has('comment.update')).toBe(false)
  })

  test('AC-2: a full row is held by hasOwn as well', () => {
    expect(permissionSet(['comment.update']).hasOwn('comment.update')).toBe(true)
  })

  test('AC-2 (edge): hasOwn of an unrelated key is false', () => {
    const set = permissionSet(['comment.update.own'])

    expect(set.hasOwn('comment.delete')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-3 — the empty set fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-3: EMPTY_PERMISSIONS holds nothing', () => {
  test('AC-3: has and hasOwn both return false', () => {
    expect(EMPTY_PERMISSIONS.has('ticket.read')).toBe(false)
    expect(EMPTY_PERMISSIONS.hasOwn('ticket.read')).toBe(false)
  })

  test('AC-3 (edge): even an own key is not held', () => {
    expect(EMPTY_PERMISSIONS.has('ticket.read.own')).toBe(false)
    expect(EMPTY_PERMISSIONS.hasOwn('ticket.read.own')).toBe(false)
  })
})
