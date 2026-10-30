import { afterAll, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'

/**
 * P3b US-006 AC-11: the palette's `approvals` command.
 *
 * `/approvals` is a top-level destination (the header badge and the sidebar both lead there), so the
 * command palette offers it too — on the caller's own decide keys (`mayDecide()`), never on a role
 * name. A narrowed `approval.decide@<pattern>` counts: the caller can decide something.
 *
 * Same harness as tests/components/command-palette-roles.spec.ts: the palette's search box uses
 * `v-model`, which the fake renderer cannot host, so the spec mounts a copy whose only change is
 * `v-model="query"` becoming `:value="query"`.
 */
const realPalette = webFile('components', 'CommandPalette.vue')

const scratch = mkdtempSync(join(tmpdir(), 'palette-approvals-'))
const paletteCopy = join(scratch, 'CommandPalette.vue')
writeFileSync(paletteCopy, readFileSync(realPalette, 'utf-8').replace('v-model="query"', ':value="query"'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A Dialog that renders its slot only while open, as the real one does. */
const dialogStub = {
  name: 'StubDialog',
  props: ['open'],
  setup(props: { open?: boolean }, { slots }: { slots: Record<string, (() => unknown) | undefined> }) {
    return () => (props.open ? Vue.h('x-stub-stub', { 'data-stub': 'dialog' }, slots.default?.() as never) : Vue.h('x-stub-stub', {}))
  },
}

const slotStub = (tag: string) => ({
  name: `Slot${tag}`,
  setup(_props: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': tag }, slots.default?.() as never)
  },
})

const hiddenStub = (tag: string) => ({
  name: `Hidden${tag}`,
  setup: () => () => Vue.h('x-stub-stub', { 'data-stub': tag }),
})

interface Mounted {
  optionIds: () => string[]
  optionLabel: (id: string) => string
  activate: (id: string) => void
  navigated: string[]
  unmount: () => void
}

/** Mounts the real palette, opened, for a viewer holding the given global keys. */
function mountPalette(keys: readonly string[], role = 'MEMBER'): Mounted {
  const navigated: string[] = []
  const app = mountSfc(paletteCopy, {
    props: { open: true },
    components: {
      ...uiStubs,
      Dialog: dialogStub,
      DialogContent: slotStub('dialog-content'),
      DialogTitle: hiddenStub('dialog-title'),
      DialogDescription: hiddenStub('dialog-description'),
    },
    globals: {
      ref, computed, watch, nextTick,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get: jest.fn(async () => []) } }),
      useColorMode: () => ({ value: 'light', preference: 'light' }),
      navigateTo: (to: string) => { navigated.push(to) },
      useAuth: () => ({ user: ref({ email: 'a@k.t', role }) }),
      useGlobalPermissions: () => globalPermissionsStub(keys),
    },
  })

  const options = (): FakeNode[] => app.find('[role="option"]')
  const optionIds = (): string[] => options().map((li) => String(li.props.id).replace(/^palette-/, ''))
  const optionLabel = (id: string): string => {
    const node = options().find((li) => li.props.id === `palette-${id}`)
    if (!node) throw new Error(`no palette entry ${id} in: ${app.text()}`)
    return app.textOf(node)
  }
  const activate = (id: string): void => {
    const node = options().find((li) => li.props.id === `palette-${id}`)
    if (!node) throw new Error(`no palette entry ${id} in: ${app.text()}`)
    ;(node.props.onClick as () => void)()
  }
  return { optionIds, optionLabel, activate, navigated, unmount: () => app.unmount() }
}

describe('us-006 AC-11: the command palette Approvals entry', () => {
  test('AC-11: it is listed for a caller who may decide, and opens /approvals', () => {
    const { optionIds, optionLabel, activate, navigated, unmount } = mountPalette(['approval.decide'])

    expect(optionIds()).toContain('approvals')
    expect(optionLabel('approvals')).toBe('Approvals')
    activate('approvals')
    expect(navigated).toEqual(['/approvals'])
    unmount()
  })

  test('AC-11: a narrowed decide key alone offers it too', () => {
    const { optionIds, activate, navigated, unmount } = mountPalette(['approval.decide@label.create'])

    expect(optionIds()).toContain('approvals')
    activate('approvals')
    expect(navigated).toEqual(['/approvals'])
    unmount()
  })

  test('AC-11 (control): no decide key lists no approvals command', () => {
    const { optionIds, unmount } = mountPalette(['user.read', 'approval.policy.manage', 'fleet.dashboard.read'])

    expect(optionIds()).not.toContain('approvals')
    unmount()
  })

  test('AC-11 (control): an ADMIN role with an empty set still gets no approvals command', () => {
    const { optionIds, unmount } = mountPalette([], 'ADMIN')

    expect(optionIds()).not.toContain('approvals')
    unmount()
  })

  test('the command sits beside the other top-level destinations, on a project route too', () => {
    const navigated: string[] = []
    const app = mountSfc(paletteCopy, {
      props: { open: true, projectSlug: 'sandbox' },
      components: {
        ...uiStubs,
        Dialog: dialogStub,
        DialogContent: slotStub('dialog-content'),
        DialogTitle: hiddenStub('dialog-title'),
        DialogDescription: hiddenStub('dialog-description'),
      },
      globals: {
        ref, computed, watch, nextTick,
        useI18n: () => enI18n(),
        useApi: () => ({ $api: { get: jest.fn(async () => []) } }),
        useColorMode: () => ({ value: 'light', preference: 'light' }),
        navigateTo: (to: string) => { navigated.push(to) },
        useAuth: () => ({ user: ref({ email: 'a@k.t', role: 'MEMBER' }) }),
        useGlobalPermissions: () => globalPermissionsStub(['approval.decide']),
      },
    })

    // The global inbox stays the target: the sidebar's project inbox link covers the project scope.
    const approvals = app.find('[role="option"]').find((li) => li.props.id === 'palette-approvals')
    if (!approvals) throw new Error(`no approvals command in: ${app.text()}`)
    ;(approvals.props.onClick as () => void)()
    expect(navigated).toEqual(['/approvals'])
    app.unmount()
  })
})
