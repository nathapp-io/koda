/**
 * US-007 disabled-user regression anchor, re-pinned for the Permissions P1 US-013 panel.
 *
 * A disabled account cannot act on the project, so the API refuses every write for it: the row keeps
 * its badge and its chips, and offers no chip add, chip remove or row removal. The positive control
 * is the other half — an enabled row the caller may manage does render those controls, so a typo
 * that hid every control could not pass both.
 */
import { describe, expect, jest, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile, type FakeNode, type Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { allById, byId } from '../helpers/roles-dom'
import { projectPermissionsStub } from '../helpers/permission-nav'

const panelFile = webFile('components', 'ProjectMembersPanel.vue')

const ROLES = [
  { id: 'r1', key: 'developer', name: 'Developer', description: '', system: true },
  { id: 'r2', key: 'verifier', name: 'Verifier', description: '', system: false },
]

const member = (disabled: boolean) => ({
  principalType: 'USER',
  principalId: 'u1',
  userId: 'u1',
  email: 'member@example.test',
  agentSlug: null,
  name: 'Member',
  disabled,
  joinedAt: '2026-01-01T00:00:00Z',
  bindings: [{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }],
})

async function mountPanel(disabled: boolean): Promise<Mounted> {
  const members = ref([member(disabled)])
  const app = mountSfc(panelFile, {
    props: { slug: 'web', projectId: 'p1' },
    components: uiStubs,
    globals: {
      useProjectMembers: () => ({
        members, total: ref(1), current: ref(1), hasNext: ref(false),
        load: jest.fn(async () => undefined), reload: jest.fn(async () => undefined),
        loadMore: jest.fn(async () => undefined), add: jest.fn(async () => undefined),
      }),
      useProjectRoles: () => ({
        roles: ref(ROLES), pending: ref(false), error: ref(null), load: jest.fn(async () => ROLES),
      }),
      useRoleBindings: () => ({ create: jest.fn(async () => undefined), remove: jest.fn(async () => undefined) }),
      useProjectPermissions: () => projectPermissionsStub(['member.add', 'role.binding.manage']),
      useAuth: () => ({ user: ref({ id: 'admin' }) }),
      useApi: () => ({ $api: { get: jest.fn(async () => []) } }),
      useI18n: () => enI18n(),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
    },
  })
  await nextTick()
  await nextTick()
  await nextTick()
  return app
}

const row = (app: Mounted): FakeNode => byId(app, 'member-row')

describe('ProjectMembersPanel disabled member (US-007 AC7/AC8/AC9)', () => {
  test('AC7: renders Disabled for a disabled project member', async () => {
    const app = await mountPanel(true)

    const badges = allById(app, 'member-disabled-badge', row(app))
    expect(badges).toHaveLength(1)
    const badge = badges[0]
    if (!badge) throw new Error('disabled badge not rendered')
    expect(app.textOf(badge)).toBe('Disabled')
    app.unmount()
  })

  test('AC8: a disabled member row carries no binding control', async () => {
    const app = await mountPanel(true)

    const memberRow = row(app)
    expect(allById(app, 'member-chip-add-role', memberRow)).toHaveLength(0)
    expect(allById(app, 'member-chip-add', memberRow)).toHaveLength(0)
    expect(allById(app, 'member-chip-remove', memberRow)).toHaveLength(0)
    expect(allById(app, 'member-row-remove', memberRow)).toHaveLength(0)
    // The chips themselves stay: the roles are still held, they just cannot be edited.
    expect(allById(app, 'member-chip', memberRow)).toHaveLength(1)
    app.unmount()
  })

  test('AC8 (positive control): an enabled member the viewer can manage renders the binding controls', async () => {
    const app = await mountPanel(false)

    const memberRow = row(app)
    expect(allById(app, 'member-chip-add-role', memberRow)).toHaveLength(1)
    expect(allById(app, 'member-chip-add', memberRow)).toHaveLength(1)
    expect(allById(app, 'member-chip-remove', memberRow)).toHaveLength(1)
    expect(allById(app, 'member-row-remove', memberRow)).toHaveLength(1)
    app.unmount()
  })

  test('AC9: renders no Disabled badge for an enabled project member', async () => {
    const app = await mountPanel(false)

    expect(allById(app, 'member-disabled-badge', row(app))).toHaveLength(0)
    app.unmount()
  })
})
