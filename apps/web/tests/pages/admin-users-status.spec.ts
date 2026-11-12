import { describe, expect, test, jest } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const users = [
  { id: 'u-active', name: 'Ada', email: 'ada@example.test', disabled: false },
  { id: 'u-disabled', name: 'Lin', email: 'lin@example.test', disabled: true },
]

function mountUsers() {
  const mounted = mountSfc(webFile('pages', 'admin', 'users.vue'), {
    globals: {
      computed,
      ref,
      definePageMeta: () => undefined,
      useI18n: () => ({ t: (key: string) => ({ 'admin.users.status.active': 'Active', 'admin.users.status.disabled': 'Disabled' }[key] ?? key) }),
      useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
      useAuth: () => ({ user: ref(null) }),
      useAdminUsers: () => ({ users: ref(users), page: ref(1), hasNext: ref(false), pending: ref(false), load: jest.fn(), setDisabled: jest.fn() }),
      useGlobalPermissions: () => ({ permissions: ref({ has: () => false }) }),
      useRoles: () => ({ roles: ref([]), load: jest.fn() }),
      useRoleBindings: () => ({ bindings: ref([]), listGlobal: jest.fn() }),
    },
    alias: {
      '~/composables/useApi': {
        ApiError: class ApiError extends Error { code = 40003 },
        extractApiError: (error: unknown) => String(error),
      },
      '~/components/PrincipalRolesDialog.vue': { __esModule: true, default: { template: '<div />' } },
    },
    components: {
      PageHeader: { template: '<header><slot name="actions" /></header>' },
      Button: { template: '<button><slot /></button>' }, Input: { template: '<input />' },
      LoadingState: { template: '<div />' },
      Table: { template: '<table><slot /></table>' }, TableHeader: { template: '<thead><slot /></thead>' },
      TableBody: { template: '<tbody><slot /></tbody>' }, TableRow: { template: '<tr><slot /></tr>' },
      TableHead: { template: '<th><slot /></th>' }, TableCell: { template: '<td><slot /></td>' },
      Badge: { template: '<span><slot /></span>' }, CreateUserDialog: { template: '<div />' },
    },
  })
  return mounted
}

describe('admin users status and actions', () => {
  test('renders active and disabled status chips and aligned per-row toggle actions', () => {
    const mounted = mountUsers()
    const chips = mounted.find('[data-testid="user-status-chip"]')
    expect(chips).toHaveLength(2)
    expect(chips.map((chip) => chip.props['data-status'])).toEqual(['active', 'disabled'])
    expect(chips.map((chip) => mounted.textOf(chip))).toEqual(['Active', 'Disabled'])
    const rows = mounted.find('[data-testid="user-row"]')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const actions = mounted.one('[data-testid="user-actions"]', row)
      expect(actions?.props.class).toBe('flex items-center justify-end gap-2')
      expect(mounted.one('[data-testid="user-toggle-disabled"]', actions)).toBeDefined()
    }
    mounted.unmount()
  })
})
