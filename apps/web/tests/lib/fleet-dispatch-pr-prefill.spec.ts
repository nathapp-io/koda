import { describe, expect, test } from '@jest/globals'
import { dispatchFeatureOf, dispatchPrefillFromQuery, prefillNotice, type DispatchFormValues } from '~/lib/fleet-dispatch'

const values = (over: Partial<DispatchFormValues> = {}): DispatchFormValues => ({
  repoId: 'r1', ref: '', command: 'RUN', feature: 'login', prNumber: '', planFrom: '', profiles: [],
  maxCostUsd: 5, selectorLabels: [], pinnedRunnerId: '', ticketRefs: [], bashMode: 'raw', approvalTimeoutMinutes: '10',
  ...over,
})

describe('dispatch PR query prefill', () => {
  test('AC-1: FIX accepts a valid PR number and profiles', () => {
    expect(dispatchPrefillFromQuery({ command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex', 'fast'] }))
      .toEqual({ command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex', 'fast'] })
  })

  test.each(['0', '023', '2.5', '2147483648'])('AC-2: rejects invalid PR number %s', prNumber => {
    expect(dispatchPrefillFromQuery({ command: 'FIX', prNumber })).not.toHaveProperty('prNumber')
  })

  test('AC-3: RUN never prefills a PR number', () => {
    expect(dispatchPrefillFromQuery({ command: 'RUN', prNumber: '23' })).not.toHaveProperty('prNumber')
  })

  test('AC-4: validates, filters, deduplicates and caps profiles', () => {
    expect(dispatchPrefillFromQuery({ profiles: ['bad name', 'koda-job-1', 'fast', 'fast'] }))
      .toEqual({ profiles: ['fast'] })
    expect(dispatchPrefillFromQuery({ profiles: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }))
      .toEqual({ profiles: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })
  })

  test('AC-5: accepts a scalar profile', () => {
    expect(dispatchPrefillFromQuery({ profiles: 'fast' })).toEqual({ profiles: ['fast'] })
  })

  test('AC-6/7: FIX always uses the review notice, with or without PR number', () => {
    expect(prefillNotice({ command: 'FIX', repoId: 'r1', prNumber: '23' })).toBe('review')
    expect(prefillNotice({ command: 'FIX', repoId: 'r1' })).toBe('review')
  })

  test('AC-8/9: derives canonical review feature, otherwise trims feature', () => {
    expect(dispatchFeatureOf(values({ command: 'FIX', prNumber: ' 23 ' }))).toBe('review-pr-23')
    expect(dispatchFeatureOf(values({ command: 'RUN', feature: ' login ' }))).toBe('login')
  })

  test('AC-10: preserves existing RUN handoff prefill', () => {
    expect(dispatchPrefillFromQuery({ command: 'RUN', repoId: 'r1', feature: 'login', ref: 'feat/login' }))
      .toEqual({ command: 'RUN', repoId: 'r1', feature: 'login', ref: 'feat/login' })
  })

  test('AC-11/12: preserves ticket and plan notices', () => {
    expect(prefillNotice({ command: 'PLAN', ticketRefs: ['WEB-3'], feature: 'web-3-add-csv-export' })).toBe('ticket')
    expect(prefillNotice({ command: 'RUN', repoId: 'r1', feature: 'f', ref: 'feat/f', ticketRefs: ['WEB-3'] })).toBe('plan')
  })
})
