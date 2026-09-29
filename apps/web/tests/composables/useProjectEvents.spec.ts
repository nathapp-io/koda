import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(__dirname, '../../composables/useProjectEvents.ts'), 'utf-8')

describe('useProjectEvents', () => {
  test('opens the stream only on mount (never during SSR) and closes on unmount', () => {
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*createProjectEventStream/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*stream\?\.close\(\)/)
  })

  test('targets the proxied events route with the slug encoded by apiPath', () => {
    expect(source).toContain('apiPath`/api/projects/${slug}/events`')
  })

  test('refreshes auth through useAuth, resolved during setup', () => {
    expect(source).toContain('const { refresh } = useAuth()')
    expect(source).toContain('refreshAuth: refresh')
  })

  test('guards environments without EventSource', () => {
    expect(source).toContain("typeof EventSource === 'undefined'")
  })
})
