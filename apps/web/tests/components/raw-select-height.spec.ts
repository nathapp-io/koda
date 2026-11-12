import { describe, expect, test, jest } from '@jest/globals'
import { computed, nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

function expectHeightAndNoLegacy(select: { props: Record<string, unknown> } | undefined, legacy: string): void {
  expect(select).toBeDefined()
  expect(String(select?.props.class)).toContain('h-10')
  expect(String(select?.props.class)).not.toContain(legacy)
}

function componentStubs(): Record<string, unknown> {
  return Object.fromEntries(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'Label', 'Button', 'Input', 'Textarea', 'Badge', 'LoadingState', 'ErrorState', 'EmptyState', 'Table', 'TableHeader', 'TableBody', 'TableRow', 'TableHead', 'TableCell']
    .map((name) => [name, { template: '<div><slot /></div>' }]))
}

describe('remaining raw select heights', () => {
  test('BackendPicker renders the shared-height selects at full width', () => {
    const mounted = mountSfc(webFile('components', 'fleet', 'threads', 'BackendPicker.vue'), {
      props: { agents: [{ agent: 'native', available: true, reason: null, models: ['gpt'], efforts: ['low'] }], agent: 'native', model: 'gpt', effort: 'low' },
      globals: { useI18n: () => ({ t: (key: string) => key }) },
      components: componentStubs(),
    })
    for (const id of ['thread-backend-agent', 'thread-backend-model', 'thread-backend-effort']) {
      const select = mounted.one(`[id="${id}"]`)
      expectHeightAndNoLegacy(select, 'h-9')
      expect(String(select?.props.class)).toContain('w-full')
    }
    mounted.unmount()
  })

  test('ApprovalPolicyDialog renders its conditional selects with shared height', async () => {
    const mounted = mountSfc(webFile('components', 'approvals', 'ApprovalPolicyDialog.vue'), {
      props: { open: true, base: { kind: 'global' }, policy: null, keys: [] },
      globals: {
        useI18n: () => ({ t: (key: string) => key }), useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
        useGlobalPermissions: () => ({ permissions: ref({ has: () => true }) }),
        useRoles: () => ({ roles: ref([]), load: async () => [{ id: 'role-1', name: 'Reviewer' }] }),
      },
      alias: {
        '~/composables/useApprovalPolicies': { useApprovalPolicies: () => ({ create: jest.fn(), update: jest.fn() }) },
        '~/composables/useApi': { extractApiError: String },
        'vee-validate': { useForm: () => ({
          handleSubmit: (fn: (value: Record<string, unknown>) => unknown) => fn,
          isSubmitting: ref(false), resetForm: jest.fn(), errors: ref({}),
          defineField: (name: string) => [ref(name === 'onTimeout' ? 'reject' : name === 'mode' ? 'ASK' : '')],
        }) },
        '@vee-validate/zod': { toTypedSchema: (schema: unknown) => schema },
      },
      components: componentStubs(),
    })
    const subject = mounted.one('[id="policy-subject-kind"]')
    expectHeightAndNoLegacy(subject, 'h-9')
    for (const id of ['policy-mode', 'policy-on-timeout']) expectHeightAndNoLegacy(mounted.one(`[id="${id}"]`), 'h-9')
    const changeSubject = subject?.props.onChange as ((event: { target: { value: string } }) => void) | undefined
    changeSubject?.({ target: { value: 'type' } })
    await nextTick()
    expectHeightAndNoLegacy(mounted.one('[id="policy-principal-type"]'), 'h-9')
    await Promise.resolve(); await Promise.resolve(); await nextTick()
    changeSubject?.({ target: { value: 'role' } })
    await nextTick()
    expectHeightAndNoLegacy(mounted.one('[id="policy-role"]'), 'h-9')
    mounted.unmount()
  })

  test('ProjectMembersPanel renders all scoped selects and keeps the agent width', async () => {
    const roles = ref([{ id: 'r1', key: 'reviewer', name: 'Reviewer' }])
    const members = ref([{ principalType: 'USER', principalId: 'u1', userId: 'u1', email: 'ada@example.test', agentSlug: null, name: 'Ada', disabled: false, joinedAt: 'now', bindings: [{ id: 'b1', roleKey: 'reader', roleName: 'Reader' }] }])
    const mounted = mountSfc(webFile('components', 'ProjectMembersPanel.vue'), {
      props: { slug: 'web', projectId: 'p1' },
      globals: {
        useI18n: () => ({ t: (key: string) => key }), useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
        useAuth: () => ({ user: ref(null) }), useProjectPermissions: () => ({ permissions: ref({ has: () => true }) }),
        useProjectMembers: () => ({ members, total: ref(1), hasNext: ref(false), load: jest.fn(), reload: jest.fn(), loadMore: jest.fn(), add: jest.fn() }),
        useProjectRoles: () => ({ roles, load: async () => roles.value }),
        useRoleBindings: () => ({ create: jest.fn(), remove: jest.fn() }),
        useApi: () => ({ $api: { get: async () => [{ id: 'a1', slug: 'bot', name: 'Bot' }] } }),
      },
      alias: {
        '~/composables/useApi': { extractApiError: String },
        '~/composables/useProjectMembers': { useProjectMembers: () => ({ members, total: ref(1), hasNext: ref(false), load: jest.fn(), reload: jest.fn(), loadMore: jest.fn(), add: jest.fn() }) },
        '~/composables/useProjectRoles': { useProjectRoles: () => ({ roles, load: async () => roles.value }) },
        '~/composables/useRoleBindings': { useRoleBindings: () => ({ create: jest.fn(), remove: jest.fn() }) },
      },
      components: componentStubs(),
    })
    await Promise.resolve(); await Promise.resolve(); await nextTick()
    for (const id of ['member-add-role', 'agent-add-select', 'agent-add-role', 'member-chip-add-role']) expectHeightAndNoLegacy(mounted.one(`[data-testid="${id}"]`), id === 'member-chip-add-role' ? 'h-8' : 'h-9')
    expect(String(mounted.one('[data-testid="agent-add-select"]')?.props.class)).toContain('max-w-xs')
    mounted.unmount()
  })

  test('RoleEditorDialog, PrincipalRolesDialog and ProjectInvitesPanel render shared-height selects', async () => {
    const globals = {
      useI18n: () => ({ t: (key: string) => key }), useAppToast: () => ({ error: jest.fn(), success: jest.fn() }),
      useGlobalPermissions: () => ({ permissions: ref({ has: () => true }) }), useProjectPermissions: () => ({ permissions: ref({ has: () => true }) }),
      useRoles: () => ({ roles: ref([{ id: 'r1', key: 'reviewer', name: 'Reviewer' }]), load: async () => [] }),
      useProjectRoles: () => ({ roles: ref([{ id: 'r1', key: 'reviewer', name: 'Reviewer' }]), load: async () => [{ id: 'r1', key: 'reviewer', name: 'Reviewer' }] }),
      useProjectInvites: () => ({ invites: ref([]), load: jest.fn(), create: jest.fn(), resend: jest.fn(), cancel: jest.fn() }),
      useRoleBindings: () => ({ bindings: ref([]), create: jest.fn(), remove: jest.fn() }),
      useApi: () => ({ $api: { get: jest.fn(async () => []) } }),
    }
    const alias = {
      '~/composables/useApi': { extractApiError: String },
      '~/composables/useProjectInvites': { useProjectInvites: globals.useProjectInvites },
      'vee-validate': { useForm: () => ({ handleSubmit: (fn: (value: Record<string, unknown>) => unknown) => fn, isSubmitting: ref(false), resetForm: jest.fn(), errors: ref({}), defineField: () => [ref('')] }) },
      '@vee-validate/zod': { toTypedSchema: (schema: unknown) => schema },
    }
    const role = mountSfc(webFile('components', 'RoleEditorDialog.vue'), { props: { open: true, role: null, readOnly: false }, globals, alias, components: componentStubs() })
    expectHeightAndNoLegacy(role.one('[id="role-scope"]'), 'h-9'); role.unmount()
    const principal = mountSfc(webFile('components', 'PrincipalRolesDialog.vue'), { props: { open: true, principal: { type: 'USER', id: 'u1', label: 'Ada' }, bindings: [], roles: [], loadError: '', blocked: false }, globals, alias, components: componentStubs() })
    expectHeightAndNoLegacy(principal.one('[data-testid="binding-role-select"]'), 'h-9'); principal.unmount()
    const invites = mountSfc(webFile('components', 'ProjectInvitesPanel.vue'), { props: { slug: 'web' }, globals, alias, components: componentStubs() })
    await nextTick()
    expectHeightAndNoLegacy(invites.one('[data-testid="invite-role"]'), 'h-9'); invites.unmount()
  })

  test('roster status select restores ACTIVE after a rejected mutation and refresh', async () => {
    const row = { slug: 'bot', name: 'Bot', status: 'ACTIVE', capabilities: [], openTicketCount: 0 }
    const items = ref([row])
    const refresh = jest.fn(async () => { items.value = [row] })
    const changeStatus = jest.fn(async () => { throw new Error('rejected') })
    const mounted = mountSfc(webFile('pages', '[project]', 'agents.vue'), {
      globals: {
        computed, ref, definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'web' } }), useI18n: () => ({ t: (key: string) => key }),
        useAppToast: () => ({ error: jest.fn() }), useGlobalPermissions: () => ({ permissions: ref({ has: () => true }) }),
        useProjectAgents: () => ({ pending: ref(false), error: ref(null), items, refresh, changeStatus }),
      },
      alias: {
        '~/composables/useApi': { extractApiError: String },
        '~/composables/useProjectAgents': { useProjectAgents: () => ({ pending: ref(false), error: ref(null), items, refresh, changeStatus }) },
      },
      components: { ...componentStubs(), PageHeader: { template: '<header />' } },
    })
    const select = mounted.one('select')
    expectHeightAndNoLegacy(select, 'h-8')
    expect(String(select?.props.class)).toContain('disabled:opacity-50')
    const onChange = select?.props.onChange as ((event: { target: { value: string } }) => void) | undefined
    if (!select) throw new Error('roster status select did not render')
    select.value = 'PAUSED'
    onChange?.({ target: select })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await nextTick()
    expect(changeStatus).toHaveBeenCalledWith('bot', 'PAUSED')
    expect(refresh).toHaveBeenCalled()
    expect(select?.value).toBe('ACTIVE')
    mounted.unmount()
  })
})
