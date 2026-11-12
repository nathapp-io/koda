import { describe, expect, test } from '@jest/globals'
import { flowTitle } from '~/lib/fleet-flows'

describe('flowTitle', () => {
  test('returns a single feature name', () => expect(flowTitle({ features: [{ feature: 'f17-min3' }] })).toBe('f17-min3'))
  test('joins feature names', () => expect(flowTitle({ features: [{ feature: 'a' }, { feature: 'b' }] })).toBe('a, b'))
  test('returns null when there are no features', () => expect(flowTitle({ features: [] })).toBeNull())
})
