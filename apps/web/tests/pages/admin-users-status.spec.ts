import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { webFile } from '../helpers/mount-sfc'

const source = readFileSync(webFile('pages', 'admin', 'users.vue'), 'utf8')

describe('admin users status and actions', () => {
  test('renders status chips with state semantics and text', () => {
    expect(source).toMatch(/data-testid="user-status-chip"/)
    expect(source).toMatch(/:data-status="user\.disabled \? 'disabled' : 'active'"/)
    expect(source).toMatch(/bg-status-done/)
    expect(source).toMatch(/bg-status-rejected/)
    expect(source).toMatch(/admin\.users\.status\.disabled/)
    expect(source).toMatch(/admin\.users\.status\.active/)
  })
  test('aligns row actions and identifies the toggle', () => {
    expect(source).toMatch(/data-testid="user-actions" class="flex items-center justify-end gap-2"/)
    expect(source).toMatch(/data-testid="user-toggle-disabled"/)
  })
})
