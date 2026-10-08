import { describe, expect, test } from '@jest/globals'

type Tree = { [key: string]: string | Tree }
const en = require('../../i18n/locales/en.json') as { notifications?: Tree }
const zh = require('../../i18n/locales/zh.json') as { notifications?: Tree }

const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`))

describe('S4a locale parity (notifications)', () => {
  test('en and zh define the same non-empty keys', () => {
    expect(en.notifications).toBeDefined()
    const enKeys = leaves(en.notifications ?? {}).map(([k]) => k).sort()
    const zhLeaves = leaves(zh.notifications ?? {})
    expect(zhLeaves.map(([k]) => k).sort()).toEqual(enKeys)
    for (const [, value] of zhLeaves) expect(value.trim()).not.toBe('')
  })

  test('every category has a label and a description', () => {
    for (const c of ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH']) {
      expect((en.notifications?.categories as Tree)[c]).toEqual(expect.objectContaining({ label: expect.any(String), description: expect.any(String) }))
    }
  })

  test('no message uses vue-i18n special characters @ $ | outside placeholders', () => {
    for (const [key, value] of [...leaves(en.notifications ?? {}), ...leaves(zh.notifications ?? {})]) {
      expect([key, /[@$|]/.test(value)]).toEqual([key, false])
    }
  })
})
