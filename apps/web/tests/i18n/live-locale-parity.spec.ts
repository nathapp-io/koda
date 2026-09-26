import { describe, expect, test } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as { tickets: { live?: Record<string, string> } }
const zh = require('../../i18n/locales/zh.json') as { tickets: { live?: Record<string, string> } }

describe('Slice 5 locale parity (tickets.live)', () => {
  test('en and zh define the same non-empty keys', () => {
    expect(en.tickets.live).toBeDefined()
    expect(Object.keys(zh.tickets.live ?? {}).sort()).toEqual(Object.keys(en.tickets.live ?? {}).sort())
    for (const value of Object.values(zh.tickets.live ?? {})) expect(value.trim()).not.toBe('')
  })
})
