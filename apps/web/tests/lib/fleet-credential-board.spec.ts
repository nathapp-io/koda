import { describe, expect, test } from '@jest/globals'
import { cellLabelKey, cellTone, profileCellLabel, rowNeeds } from '~/lib/fleet-credential-board'

describe('fleet credential board helpers (S3 §6)', () => {
  test('tones follow the chip scale', () => {
    expect(cellTone('ok')).toBe('ok')
    expect(cellTone('expiring')).toBe('warn')
    expect(cellTone('expired')).toBe('warn')
    expect(cellTone('unavailable')).toBe('bad')
    expect(cellTone('missing')).toBe('bad')
  })

  test('state label keys, with a fallback for an unknown state', () => {
    expect(cellLabelKey('expiring')).toBe('fleet.credentials.state.expiring')
    expect(cellLabelKey('weird')).toBe('fleet.credentials.state.unknown')
  })

  test('profile cell labels: unknown, absent, misfit, ready', () => {
    expect(profileCellLabel(undefined)).toEqual({ key: 'fleet.credentials.profiles.unknown' })
    expect(profileCellLabel({ present: false })).toEqual({ key: 'fleet.credentials.profiles.absent' })
    expect(profileCellLabel({ present: true, misfit: 'sandbox' })).toEqual({ key: 'fleet.misfit.sandbox' })
    expect(profileCellLabel({ present: true })).toEqual({ key: 'fleet.credentials.profiles.ready' })
  })

  test('row needs come from the first present runner and flag disagreement', () => {
    const fast = { protocol: 'native', providers: ['b', 'a'], sandbox: false }
    expect(rowNeeds({ name: 'fast', runners: { r1: { present: false }, r2: { present: true, needs: fast } } }))
      .toEqual({ needs: fast, differs: false })
    expect(rowNeeds({ name: 'fast', runners: { r1: { present: true, needs: fast }, r2: { present: true, needs: { ...fast, providers: ['a', 'b'] } } } }).differs)
      .toBe(false)
    expect(rowNeeds({ name: 'fast', runners: { r1: { present: true, needs: fast }, r2: { present: true, needs: { ...fast, sandbox: true } } } }).differs)
      .toBe(true)
    expect(rowNeeds({ name: 'gone', runners: { r1: { present: false } } })).toEqual({ needs: null, differs: false })
  })
})
