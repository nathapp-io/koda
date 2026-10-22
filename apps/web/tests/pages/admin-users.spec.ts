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

  test('an admin cannot disable their own row from the UI', () => {
    const page = read('pages', 'admin', 'users.vue')
    expect(page).toMatch(/:disabled="isSelf\(user\)"/)
  })

  test('global roles are managed through the shared principal dialog, not a role select (US-011)', () => {
    const page = read('pages', 'admin', 'users.vue')
    expect(page).toContain('<PrincipalRolesDialog')
    expect(page).toContain("import PrincipalRolesDialog from '~/components/PrincipalRolesDialog.vue'")
    expect(page).not.toContain('setRole')
  })

  test('dialog posts through useAdminUsers().createUser', () => {
    const dialog = read('components', 'CreateUserDialog.vue')
    expect(dialog).toContain('createUser(')
    expect(dialog).toContain("emit('created')")
  })

  test('sidebar shows Users only with the user.read permission key', () => {
    const layout = read('layouts', 'default.vue')
    expect(layout).toMatch(/v-if="canReadUsers"[^>]*to="\/admin\/users"|to="\/admin\/users"[^>]*v-if="canReadUsers"/)
  })

  test('the sidebar decides no admin link on a role name (US-006)', () => {
    const layout = read('layouts', 'default.vue')
    expect(layout).not.toMatch(/role === 'ADMIN'/)
    expect(layout).not.toContain('isGlobalAdmin')
  })
})
