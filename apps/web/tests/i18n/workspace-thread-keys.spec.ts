import { describe, expect, test } from '@jest/globals'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

/**
 * US-005 AC-15 (fleet S5b 1d): the four keys the personal thread pages and the sidebar link read.
 * Both locales must define them, because `used-keys-exist.spec.ts` only proves a key exists in the
 * locales — it cannot prove the Chinese copy was written.
 */
const REQUIRED = [
  'nav.myThreads',
  'fleet.threads.workspace.title',
  'fleet.threads.workspace.homeProject',
  'fleet.threads.workspace.homeAutomatic',
] as const

function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

describe('US-005 AC-15: the workspace thread i18n keys', () => {
  test.each(REQUIRED)('en.json and zh.json both define %s', (key) => {
    for (const locale of [en, zh]) {
      const value = lookup(locale, key)
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
    }
  })
})
