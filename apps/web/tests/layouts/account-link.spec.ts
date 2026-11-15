import { test, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('AC-10 header account link points to account settings', () => {
  const source = readFileSync(join(__dirname, '../../layouts/default.vue'), 'utf8')
  const header = source.match(/<header[\s\S]*?<\/header>/)?.[0] ?? ''
  expect(header).toMatch(/<NuxtLink\s+[^>]*to="\/settings\/account"[^>]*data-testid="header-account-link"/)
})
