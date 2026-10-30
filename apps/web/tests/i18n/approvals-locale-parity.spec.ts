import { describe, expect, test } from '@jest/globals'

type Tree = { [key: string]: string | Tree }
const en = require('../../i18n/locales/en.json') as { approvals?: Tree }
const zh = require('../../i18n/locales/zh.json') as { approvals?: Tree }

const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`))

/**
 * P3b US-001: the `approvals` namespace is shared by every story of this feature, and each story adds
 * its own part. Comparing the whole namespace (not one story's keys) is what keeps en and zh from
 * drifting apart as the feature grows.
 */
describe('P3b approvals locale parity', () => {
  test('en and zh define the same non-empty approvals keys', () => {
    expect(en.approvals).toBeDefined()
    expect(zh.approvals).toBeDefined()
    const enLeaves = leaves(en.approvals ?? {})
    const zhLeaves = leaves(zh.approvals ?? {})
    expect(enLeaves.length).toBeGreaterThan(0)
    expect(zhLeaves.map(([key]) => key).sort()).toEqual(enLeaves.map(([key]) => key).sort())
    for (const [key, value] of [...enLeaves, ...zhLeaves]) expect([key, value.trim().length > 0]).toEqual([key, true])
  })

  test('US-001: the two fleet keys have a label in both locales', () => {
    for (const locale of [en, zh]) {
      const keys = locale.approvals?.keys as Tree
      expect(typeof keys?.fleet_job_shell_escalate).toBe('string')
      expect(typeof keys?.fleet_budget_override).toBe('string')
    }
  })

  test('US-001: the comment cap message exists in both locales', () => {
    for (const locale of [en, zh]) {
      expect(typeof (locale.approvals?.comment as Tree)?.tooLong).toBe('string')
    }
  })

  test('no approvals message uses vue-i18n special characters @ $ | outside placeholders', () => {
    for (const [key, value] of [
      ...leaves(en.approvals ?? {}),
      ...leaves(zh.approvals ?? {}),
    ]) {
      expect([key, /[@$|]/.test(value)]).toEqual([key, false])
    }
  })
})
