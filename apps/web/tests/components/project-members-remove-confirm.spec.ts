import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { projectPermissionsStub } from '../helpers/permission-nav'

const confirm = jest.fn(async () => false)
const remove = jest.fn(async () => undefined)
const reload = jest.fn(async () => undefined)
const row = { principalType: 'USER', principalId: 'u1', userId: 'u1', email: 'member@example.test', agentSlug: null, name: 'Avery Member', disabled: false, joinedAt: '2026-01-01T00:00:00Z', bindings: [{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }] }
async function mount() {
  const app = mountSfc(webFile('components', 'ProjectMembersPanel.vue'), {
    props: { slug: 'web', projectId: 'p1' },
    components: uiStubs,
    globals: {
      useProjectMembers: () => ({ members: ref([row]), total: ref(1), hasNext: ref(false), load: jest.fn(async () => undefined), reload, loadMore: jest.fn(async () => undefined), add: jest.fn(async () => undefined) }),
      useProjectRoles: () => ({ roles: ref([{ id: 'r1', key: 'developer', name: 'Developer', description: '', system: true }]), load: jest.fn(async () => []) }),
      useRoleBindings: () => ({ create: jest.fn(async () => undefined), remove }),
      useProjectPermissions: () => projectPermissionsStub(['role.binding.manage']),
      useAuth: () => ({ user: ref({ id: 'admin' }) }),
      useApi: () => ({ $api: { get: jest.fn(async () => []) } }),
      useI18n: () => enI18n(),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      useConfirm: () => ({ confirm }),
    },
  })
  await nextTick(); await nextTick(); await nextTick()
  return app
}
afterEach(() => { confirm.mockReset().mockResolvedValue(false); remove.mockClear(); reload.mockClear() })

describe('ProjectMembersPanel row removal confirmation', () => {
  test('AC-7: remove row confirms with interpolated display name and destructive options', async () => {
    const app = await mount()
    await (app.one('[data-testid="member-row-remove"]')?.props.onClick as () => Promise<void>)()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({ title: 'Remove Avery Member from this project?', body: 'All of their roles in this project are removed.', confirmLabel: 'Remove', destructive: true })
    expect(remove).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-8: declining row removal leaves bindings and list untouched', async () => {
    confirm.mockResolvedValue(false)
    const app = await mount()
    await (app.one('[data-testid="member-row-remove"]')?.props.onClick as () => Promise<void>)()
    expect(remove).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(app.find('[data-testid="member-chip"]')).toHaveLength(1)
    app.unmount()
  })
})
