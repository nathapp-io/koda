import { describe, expect, test } from '@jest/globals'

type Tree = { [key: string]: string | Tree }
const en = require('../../i18n/locales/en.json') as { skills?: Tree }
const zh = require('../../i18n/locales/zh.json') as { skills?: Tree }

const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`))

describe('S5a locale parity (skills)', () => {
  test('en and zh define the same non-empty keys', () => {
    expect(en.skills).toBeDefined()
    const enKeys = leaves(en.skills ?? {}).map(([k]) => k).sort()
    const zhLeaves = leaves(zh.skills ?? {})
    expect(zhLeaves.map(([k]) => k).sort()).toEqual(enKeys)
    for (const [, value] of zhLeaves) expect(value.trim()).not.toBe('')
  })

  test('no skills message uses vue-i18n special characters or HTML outside placeholders', () => {
    for (const [key, value] of [...leaves(en.skills ?? {}), ...leaves(zh.skills ?? {})]) {
      const withoutPlaceholders = value.replace(/\{\w+\}/g, '')
      expect([key, /[@$|<>]/.test(withoutPlaceholders)]).toEqual([key, false])
    }
  })
})
