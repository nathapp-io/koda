import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(__dirname, '../../composables/useProjectEvents.ts'), 'utf-8')

describe('useProjectEvents', () => {
  test('subscribes only on mount (never during SSR) and unsubscribes on unmount', () => {
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*\.subscribe\(/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*unsubscribe\?\.\(\)/)
  })

  test('targets the proxied events route with the slug encoded by apiPath', () => {
    expect(source).toContain('apiPath`/api/projects/${slug}/events`')
  })

  test('refreshes auth through useAuth, resolved during setup, read at call time by the shared hub', () => {
    expect(source).toContain('const { refresh } = useAuth()')
    expect(source).toContain('refreshAuth: () => latestRefresh()')
  })

  test('guards environments without EventSource', () => {
    expect(source).toContain("typeof EventSource === 'undefined'")
  })
})
