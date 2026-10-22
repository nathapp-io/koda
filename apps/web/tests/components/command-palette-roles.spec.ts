import { afterAll, describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'
import * as apiModule from '../../composables/useApi'

/**
 * US-010 (M1): the palette's `roles` command. Admin → Roles is a new top-level destination, and the app
 * guidance requires every top-level destination to be reachable from the command palette; it gates on
 * the key `GET /roles` needs (`role.read`), never on a role name.
 *
 * Same harness as tests/components/command-palette-my-threads.spec.ts: the palette's search box uses
 * `v-model`, which the fake renderer cannot host, so the spec mounts a copy whose only change is
 * `v-model="query"` becoming `:value="query"`.
 */
const realPalette = webFile('components', 'CommandPalette.vue')

const scratch = mkdtempSync(join(tmpdir(), 'palette-roles-'))
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
    alias: { '~/composables/useApi': apiModule },
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

describe('US-010 M1: the command palette Roles entry', () => {
  test('it is listed for a caller holding role.read and opens /admin/roles', () => {
    const { optionIds, optionLabel, activate, navigated, unmount } = mountPalette(['role.read'])

    expect(optionIds()).toContain('roles')
    expect(optionLabel('roles')).toContain('Roles')
    activate('roles')
    expect(navigated).toEqual(['/admin/roles'])
    unmount()
  })

  test('an empty global set lists no roles command', () => {
    const { optionIds, unmount } = mountPalette([])

    expect(optionIds()).not.toContain('roles')
    unmount()
  })

  test('an ADMIN role with an empty set still gets no roles command', () => {
    const { optionIds, unmount } = mountPalette([], 'ADMIN')

    expect(optionIds()).not.toContain('roles')
    unmount()
  })

  test('another admin key does not unlock it', () => {
    const { optionIds, unmount } = mountPalette(['user.read', 'skill.source.read', 'fleet.dashboard.read'])

    expect(optionIds()).not.toContain('roles')
    unmount()
  })

  test('control: role.read does not unlock the skills command', () => {
    const { optionIds, unmount } = mountPalette(['role.read'])

    expect(optionIds()).toEqual(expect.arrayContaining(['roles', 'dashboard']))
    expect(optionIds()).not.toContain('skills')
    unmount()
  })
})
