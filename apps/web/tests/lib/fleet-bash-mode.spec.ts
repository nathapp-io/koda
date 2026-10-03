import { describe, expect, test } from '@jest/globals'
import {
  BASH_MODES, bashCreateFields, bashPatchFields, bashSummary, DEFAULT_APPROVAL_TIMEOUT_SEC, isBashTimeoutValid,
  minutesText, parseTimeoutMinutes, usesRelay,
} from '../../lib/fleet-bash-mode'
import { enI18n } from '../helpers/fleet-harness'

describe('fleet bash mode (D298)', () => {
  test('modes are the API enum, raw first', () => {
    expect([...BASH_MODES]).toEqual(['raw', 'gated', 'escalate'])
    expect(usesRelay('raw')).toBe(false)
    expect(usesRelay('gated')).toBe(true)
    expect(usesRelay('escalate')).toBe(true)
  })

  test('minutes parse to whole seconds in 30..3600', () => {
    expect(parseTimeoutMinutes('10')).toBe(600)
    expect(parseTimeoutMinutes(' 0.5 ')).toBe(30)
    expect(parseTimeoutMinutes('60')).toBe(3600)
    expect(parseTimeoutMinutes('1.25')).toBe(75)
  })

  test.each(['', '0', '0.4', '60.01', '61', '1.234', '-1', '1e1', 'ten', '1,5', '.5'])('%p is refused', (input) => {
    expect(parseTimeoutMinutes(input)).toBeNull()
  })

  test('every whole second in range survives the minutes round trip (Review Focus 5)', () => {
    for (let sec = 30; sec <= 3600; sec += 1) expect(parseTimeoutMinutes(minutesText(sec))).toBe(sec)
  })

  test('the default reads as 10 minutes; 90 s reads as 1.5', () => {
    expect(minutesText(DEFAULT_APPROVAL_TIMEOUT_SEC)).toBe('10')
    expect(minutesText(90)).toBe('1.5')
  })

  test('only a relay mode needs a valid timeout', () => {
    expect(isBashTimeoutValid('raw', '')).toBe(true)
    expect(isBashTimeoutValid('escalate', '')).toBe(false)
    expect(isBashTimeoutValid('gated', '5')).toBe(true)
  })

  test('create fields: raw sends nothing, a relay mode sends both (D299, D300)', () => {
    expect(bashCreateFields('raw', 'garbage')).toEqual({})
    expect(bashCreateFields('escalate', '2')).toEqual({ bashMode: 'escalate', approvalTimeoutSec: 120 })
  })

  test('patch fields: the mode always travels, the timeout only for a relay mode (D300)', () => {
    expect(bashPatchFields('raw', '')).toEqual({ bashMode: 'raw' })
    expect(bashPatchFields('gated', '1.5')).toEqual({ bashMode: 'gated', approvalTimeoutSec: 90 })
  })

  test('a relay mode with an unvalidated timeout throws instead of sending a guess', () => {
    expect(() => bashCreateFields('gated', 'x')).toThrow('not validated')
  })

  test('the shell approvals line', () => {
    const { t } = enI18n()
    expect(bashSummary(t, 'raw', 600)).toBe('Off')
    expect(bashSummary(t, 'escalate', 90)).toBe('Escalate, asks wait 1.5 min')
  })
})
