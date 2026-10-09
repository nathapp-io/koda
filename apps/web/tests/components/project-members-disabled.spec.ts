import { describe, expect, test, jest } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const panelFile = webFile('components', 'ProjectMembersPanel.vue')
const member = (disabled: boolean) => ({
  userId: 'u1', email: 'member@example.test', name: 'Member', role: 'DEVELOPER',
  joinedAt: '2026-01-01T00:00:00Z', disabled,
})

async function mountPanel(disabled: boolean) {
  const members = ref([member(disabled)])
  const app = mountSfc(panelFile, {
    props: { slug: 'web' },
    components: uiStubs,
    globals: {
      useProjectMembers: () => ({
        members, total: ref(1), hasNext: ref(false), canManage: ref(true),
        load: jest.fn(async () => undefined), reload: jest.fn(async () => undefined),
        loadMore: jest.fn(async () => undefined), add: jest.fn(async () => undefined),
        changeRole: jest.fn(async () => undefined), remove: jest.fn(async () => undefined),
      }),
      useI18n: () => enI18n(),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      extractApiError: (error: unknown) => String(error),
      onMounted: (callback: () => void) => callback(),
    },
  })
  await nextTick()
  await nextTick()
  return app
}

describe('ProjectMembersPanel disabled member badge (US-007)', () => {
  test('AC7: renders Disabled for a disabled project member', async () => {
    const app = await mountPanel(true)
    expect(app.text()).toContain('Disabled')
    app.unmount()
  })

  test('AC8: hides a disabled member role select when the viewer can manage members', async () => {
    const app = await mountPanel(true)
    expect(app.find('select').filter((select) => select.props.value === 'DEVELOPER')).toHaveLength(0)
    app.unmount()
  })

  test('AC9: renders no Disabled badge for an enabled project member', async () => {
    const app = await mountPanel(false)
    expect(app.text()).not.toContain('Disabled')
    app.unmount()
  })
})
