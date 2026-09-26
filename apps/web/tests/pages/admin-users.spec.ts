import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('Slice 4: admin users page wiring', () => {
  test('page loads through useAdminUsers and handles the admin-only 403', () => {
    const page = read('pages', 'admin', 'users.vue')
    expect(page).toContain('useAdminUsers()')
    expect(page).toContain('isForbidden(')
    expect(page).toContain('<CreateUserDialog')
  })

  test('an admin cannot disable or demote their own row from the UI', () => {
    const page = read('pages', 'admin', 'users.vue')
    expect(page).toMatch(/:disabled="isSelf\(user\)"/)
  })

  test('dialog posts through useAdminUsers().createUser', () => {
    const dialog = read('components', 'CreateUserDialog.vue')
    expect(dialog).toContain('createUser(')
    expect(dialog).toContain("emit('created')")
  })

  test('sidebar shows Users only to global admins', () => {
    const layout = read('layouts', 'default.vue')
    expect(layout).toMatch(/v-if="isGlobalAdmin"[^>]*to="\/admin\/users"|to="\/admin\/users"[^>]*v-if="isGlobalAdmin"/)
  })
})
