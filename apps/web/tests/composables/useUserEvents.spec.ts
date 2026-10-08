import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(__dirname, '../../composables/useUserEvents.ts'), 'utf-8')

describe('useUserEvents (S4a §5)', () => {
  test('subscribes only on mount (never during SSR) and unsubscribes on unmount', () => {
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*\.subscribe\(USER_EVENTS_URL/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*unsubscribe\?\.\(\)/)
  })

  test('targets the proxied user stream and handles notices and resyncs', () => {
    expect(source).toContain("export const USER_EVENTS_URL = '/api/me/events'")
    expect(source).toContain('onNotification: () => onEvent()')
    expect(source).toContain('onResync: () => onEvent()')
  })

  test('keeps a 60 s visible-tab poll as the backstop when the stream is down or refused', () => {
    expect(source).toContain('export const USER_EVENTS_POLL_MS = 60_000')
    expect(source).toMatch(/useVisiblePolling\([\s\S]*USER_EVENTS_POLL_MS/)
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*polling\.start\(\)/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*polling\.stop\(\)/)
  })

  test('guards environments without EventSource and refreshes auth through useAuth', () => {
    expect(source).toContain("typeof EventSource === 'undefined'")
    expect(source).toContain('const { refresh } = useAuth()')
  })
})
