import { describe, expect, test } from '@jest/globals'
import { fixDispatchQuery, showFixAction } from '~/lib/fleet-jobs'

describe('showFixAction', () => {
  const job = { command: 'REVIEW', state: 'COMPLETED', feature: 'review-pr-23' }

  test('AC-1: shows Fix for a completed review when dispatch is allowed', () => {
    expect(showFixAction(job, true)).toBe(true)
  })

  test.each([
    ['dispatch permission is absent', job, false],
    ['job did not complete', { ...job, state: 'FAILED' }, true],
    ['job is a FIX', { ...job, command: 'FIX' }, true],
    ['feature is not a review PR', { ...job, feature: 'login' }, true],
    ['PR number exceeds the API bound', { ...job, feature: 'review-pr-2147483648' }, true],
  ] as const)('AC-2: hides Fix when %s', (_reason, candidate, canDispatch) => {
    expect(showFixAction(candidate, canDispatch)).toBe(false)
  })
})

describe('fixDispatchQuery', () => {
  test('AC-3: constructs a FIX query with the parsed PR and profiles', () => {
    expect(fixDispatchQuery({ repoId: 'r1', feature: 'review-pr-23', profiles: ['native-codex'] })).toEqual({
      command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex'],
    })
  })

  test('AC-4: copies the profiles array', () => {
    const profiles = ['native-codex']
    const query = fixDispatchQuery({ repoId: 'r1', feature: 'review-pr-23', profiles })
    expect(query?.profiles).not.toBe(profiles)
    expect(query?.profiles).toEqual(profiles)
  })

  test('AC-5: omits empty profiles', () => {
    expect(fixDispatchQuery({ repoId: 'r1', feature: 'review-pr-23', profiles: [] })).toEqual({
      command: 'FIX', repoId: 'r1', prNumber: '23',
    })
  })

  test('AC-6: returns null for a non-review feature', () => {
    expect(fixDispatchQuery({ repoId: 'r1', feature: 'login', profiles: [] })).toBeNull()
  })
})
