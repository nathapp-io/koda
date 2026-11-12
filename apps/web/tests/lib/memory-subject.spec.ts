import { describe, expect, test } from '@jest/globals'
import { memorySubject } from '../../lib/memory-subject'

describe('memorySubject', () => {
  test('parses and shortens ticket subjects', () => {
    expect(memorySubject('ticket:cmw852hth00c408tguaxw2f78')).toEqual({ type: 'ticket', id: 'cmw852hth00c408tguaxw2f78', short: 'cmw852ht' })
  })
  test('parses and shortens agent subjects', () => {
    expect(memorySubject('agent:a1')).toEqual({ type: 'agent', id: 'a1', short: 'a1' })
  })
  test('preserves other subjects', () => {
    expect(memorySubject('deploy')).toEqual({ type: 'other', id: 'deploy', short: 'deploy' })
  })
  test('treats an empty prefixed subject as other', () => {
    expect(memorySubject('ticket:')).toEqual({ type: 'other', id: 'ticket:', short: 'ticket:' })
  })
  test('splits only on the first colon', () => {
    expect(memorySubject('ticket:a:b')).toEqual({ type: 'ticket', id: 'a:b', short: 'a:b' })
  })
})
