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
    const badges = app.find('[data-testid="member-disabled-badge"]')
    expect(badges).toHaveLength(1)
    const badge = badges[0]
    if (!badge) throw new Error('disabled badge not rendered')
    expect(app.textOf(badge)).toBe('Disabled')
    app.unmount()
  })

  test('AC8: hides a disabled member role select when the viewer can manage members', async () => {
    const app = await mountPanel(true)
    // The role control is a native <select> in the legacy implementation and
    // a Button radiogroup (`role="radiogroup"`) in the current one. Both
    // flavours live inside the disabled member's <li> when the viewer can
    // manage; the spec requires the per-member control to be hidden, so walk
    // from the disabled badge up to the <li> and assert no role control
    // (select or radiogroup) survives inside it.
    //
    // The previous assertion searched the whole tree for `select` and is
    // vacuous now: no native <select> is rendered anywhere on the page, so
    // it is always empty and passes for any member state.
    const badge = app.one('[data-testid="member-disabled-badge"]')
    if (!badge) throw new Error('disabled badge not rendered')
    const memberLi = badge.parent?.parent?.parent
    if (!memberLi) throw new Error('disabled badge has no enclosing <li>')
    expect(memberLi.tag).toBe('li')
    const roleControlsInLi = [
      ...app.find('[role="radiogroup"]', memberLi),
      ...app.find('select', memberLi),
    ]
    expect(roleControlsInLi).toHaveLength(0)
    app.unmount()
  })

  test('AC9: renders no Disabled badge for an enabled project member', async () => {
    const app = await mountPanel(false)
    expect(app.find('[data-testid="member-disabled-badge"]')).toHaveLength(0)
    app.unmount()
  })
})
