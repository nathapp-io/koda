import { expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

test('ticket detail loaded-ticket grid defines a second desktop row', () => {
  const source = readFileSync(join(__dirname, '../../pages/[project]/tickets/[ref].vue'), 'utf8')
  const grid = source.match(/<div v-else-if="ticket" class="([^"]+)"/)?.[1]
  expect(grid?.split(/\s+/)).toContain('lg:grid-rows-[auto_1fr]')
})
