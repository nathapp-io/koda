import { describe, expect, test } from '@jest/globals'
import {
  filterMentionCandidates, insertMention, mentionQuery, mentionToken, splitMentions, withMentionChips,
} from '~/lib/mentions'
import type { ProjectMember } from '~/composables/useProjectMembers'

const ID = 'c000000000000000000000001'
const ID2 = 'c000000000000000000000002'
const member = (userId: string, name: string | null, email: string): ProjectMember =>
  ({ userId, name, email, role: 'DEVELOPER', joinedAt: '2026-10-01T00:00:00.000Z' })

describe('mentionToken (D504)', () => {
  test('builds the API grammar', () => {
    expect(mentionToken('Ann Lee', ID)).toBe(`@[Ann Lee](user:${ID})`)
  })
  test('strips ] and newlines from the label so the token stays parseable', () => {
    expect(mentionToken('A]n\nn', ID)).toBe(`@[Ann](user:${ID})`)
    expect(mentionToken(']]', ID)).toBe(`@[user](user:${ID})`)
  })
})

describe('splitMentions', () => {
  test('splits text and tokens in order', () => {
    expect(splitMentions(`hi @[Ann](user:${ID}), see @[Bo](user:${ID2})!`)).toEqual([
      { text: 'hi ' }, { userId: ID, label: 'Ann' }, { text: ', see ' }, { userId: ID2, label: 'Bo' }, { text: '!' },
    ])
  })
  test('plain text and malformed tokens stay text', () => {
    expect(splitMentions('ping @alice')).toEqual([{ text: 'ping @alice' }])
    expect(splitMentions('@[x](user:)')).toEqual([{ text: '@[x](user:)' }])
    expect(splitMentions('')).toEqual([])
  })
})

describe('mentionQuery', () => {
  test.each([
    ['@', 1, { start: 0, query: '' }],
    ['hi @an', 6, { start: 3, query: 'an' }],
    ['hi @an more', 6, { start: 3, query: 'an' }],
    ['line\n@bo', 8, { start: 5, query: 'bo' }],
  ])('%j at %d -> %j', (text, caret, expected) => {
    expect(mentionQuery(text, caret)).toEqual(expected)
  })
  test.each([
    ['email@example', 13],
    ['hi @an ', 7],
    ['no at', 5],
    [`@[Ann](user:${ID})`, 32],
  ])('%j at %d -> null', (text, caret) => {
    expect(mentionQuery(text, caret)).toBeNull()
  })
})

describe('insertMention', () => {
  test('replaces @query with the token plus a space and moves the caret after it', () => {
    const token = `@[Ann](user:${ID}) `
    expect(insertMention('hi @an and', 3, 6, 'Ann', ID)).toEqual({ text: `hi ${token} and`, caret: 3 + token.length })
  })
})

describe('filterMentionCandidates', () => {
  const members = [member(ID, 'Ann Lee', 'ann@x.io'), member(ID2, null, 'bob@x.io'), member('c000000000000000000000003', 'Cy', 'cy@x.io')]
  test('matches name or email, case-insensitive', () => {
    expect(filterMentionCandidates(members, 'LEE').map((m) => m.userId)).toEqual([ID])
    expect(filterMentionCandidates(members, 'bob').map((m) => m.userId)).toEqual([ID2])
  })
  test('an empty query lists everyone up to the limit', () => {
    expect(filterMentionCandidates(members, '', 2)).toHaveLength(2)
  })
})

describe('withMentionChips', () => {
  test('replaces tokens with an escaped chip using the current name, falling back to the label', () => {
    const md = `by @[Old](user:${ID}) and @[<b>x</b>](user:${ID2})`
    const nameOf = (id: string) => (id === ID ? 'Ann & Co' : null)
    expect(withMentionChips(md, nameOf)).toBe(
      'by <span class="mention-chip">@Ann &amp; Co</span> and <span class="mention-chip">@&lt;b&gt;x&lt;/b&gt;</span>',
    )
  })

  test('keeps the token parseable by the API: strips [ and @, caps the label at 100 chars (ReDoS ruling)', () => {
    const id = 'c' + '0'.repeat(24)
    expect(mentionToken('Ann @ [Ops]', id)).toBe(`@[Ann  Ops](user:${id})`)
    const long = mentionToken('a'.repeat(150), id)
    expect(splitMentions(long)).toEqual([{ userId: id, label: 'a'.repeat(100) }])
  })

  test('is linear on hostile input (ReDoS guard)', () => {
    const started = Date.now()
    expect(splitMentions('@['.repeat(50_000))).toEqual([{ text: '@['.repeat(50_000) }])
    expect(Date.now() - started).toBeLessThan(250)
  })
})

