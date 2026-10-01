import { describe, expect, it } from '@jest/globals'
import { ageParts } from '~/lib/fleet-age'

const now = new Date('2026-10-01T12:00:00.000Z')
const before = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('ageParts', () => {
  it('uses the largest whole unit', () => {
    expect(ageParts(before(59_000), now)).toEqual({ n: 59, unit: 's' })
    expect(ageParts(before(60_000), now)).toEqual({ n: 1, unit: 'm' })
    expect(ageParts(before(3 * 3_600_000 + 59 * 60_000), now)).toEqual({ n: 3, unit: 'h' })
    expect(ageParts(before(2 * 86_400_000 + 5), now)).toEqual({ n: 2, unit: 'd' })
  })

  it('reads a future time (clock skew) as 0 s', () => {
    expect(ageParts(new Date(now.getTime() + 5_000).toISOString(), now)).toEqual({ n: 0, unit: 's' })
  })

  it('is null for a missing or unparseable time', () => {
    expect(ageParts(null, now)).toBeNull()
    expect(ageParts(undefined, now)).toBeNull()
    expect(ageParts('', now)).toBeNull()
    expect(ageParts('not a date', now)).toBeNull()
  })
})
