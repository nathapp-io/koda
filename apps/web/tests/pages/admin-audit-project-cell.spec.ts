import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { webFile } from '../helpers/mount-sfc'

const source = readFileSync(webFile('pages', 'admin', 'audit.vue'), 'utf8')

describe('admin audit project cell', () => {
  test('keeps project labels on one line and retains the filter button', () => {
    expect(source).toMatch(/<TableCell class="whitespace-nowrap" data-testid="audit-project-cell">[\s\S]*?data-testid="audit-project"[\s\S]*?projectLabel\(entry\)/)
  })
})
