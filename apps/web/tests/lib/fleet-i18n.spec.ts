import { describe, expect, test } from '@jest/globals'
import { codeLabel } from '~/lib/fleet-i18n'

const keys: Record<string, string> = { 'fleet.state.RUNNING': 'Running' }
const t = (key: string): string => keys[key] ?? `!${key}`
const te = (key: string): boolean => key in keys

describe('codeLabel', () => {
  test('translates a known code', () => {
    expect(codeLabel(t, te, 'fleet.state', 'RUNNING')).toBe('Running')
  })

  test('falls back to the raw code for an unknown one', () => {
    expect(codeLabel(t, te, 'fleet.state', 'PAUSED')).toBe('PAUSED')
  })
})
