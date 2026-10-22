import { describe, test, expect, jest, afterAll } from '@jest/globals'
import * as Vue from 'vue'
import { computed, ref, watch, nextTick } from 'vue'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { permissionSet } from '~/lib/permissions'
import * as apiModule from '../../composables/useApi'

const realPalette = webFile('components', 'CommandPalette.vue')

/**
 * The palette's search box is a native `<input v-model>`. The fake renderer in mount-sfc cannot
 * host Vue's `vModelText` directive, which calls `addEventListener` on a real element. So this spec
 * mounts a copy of the real palette whose only change is `v-model="query"` becoming `:value="query"`.
 * The `<script setup>` (the command list and the permission gate) and the rest of the template are
 * the component's own code, untouched.
 */
const scratch = mkdtempSync(join(tmpdir(), 'palette-skills-'))
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

/** Renders the slot through an inert element, so the list stays in the walkable tree. */
const slotStub = (tag: string) => ({
  name: `Slot${tag}`,
  setup(_props: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
    return () => Vue.h('x-stub-stub', { ...attrs, 'data-stub': tag }, slots.default?.() as never)
  },
})

/** A visually hidden title or description has nothing the palette test needs, so it renders no children. */
const hiddenStub = (tag: string) => ({
  name: `Hidden${tag}`,
  setup: () => () => Vue.h('x-stub-stub', { 'data-stub': tag }),
})

interface Mounted {
  optionIds: () => string[]
  activate: (id: string) => void
  navigated: string[]
  unmount: () => void
}

interface Viewer {
  /** The keys of the caller's global permission set. */
  keys?: readonly string[]
  /** True while /me/permissions is still outstanding: the set is the empty one. */
  pending?: boolean
  /** A role name, to prove the gate does not read it. */
  role?: string
}

/** Mounts the real palette, opened, for a viewer with the given global permission set. */
function mountPalette(viewer: Viewer = {}): Mounted {
  const navigated: string[] = []
  const held = permissionSet(viewer.keys ?? [])
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
      useAuth: () => ({ user: ref({ email: 'a@k.t', role: viewer.role ?? 'MEMBER' }) }),
      useGlobalPermissions: () => ({
        permissions: computed(() => (viewer.pending === true ? permissionSet([]) : held)),
        pending: ref(viewer.pending === true),
        error: ref(null),
        refresh: async () => undefined,
      }),
    },
  })

  const options = (): FakeNode[] => app.find('[role="option"]')
  const optionIds = (): string[] => options().map((li) => String(li.props.id).replace(/^palette-/, ''))
  const activate = (id: string): void => {
    const node = options().find((li) => li.props.id === `palette-${id}`)
    if (!node) throw new Error(`no palette entry ${id} in: ${app.text()}`)
    ;(node.props.onClick as () => void)()
  }
  return { optionIds, activate, navigated, unmount: () => app.unmount() }
}

const SKILLS_KEYS = ['skill.source.read']

describe('CommandPalette skills entry (US-006 AC-10)', () => {
  test('AC-10: the skills command is listed when the global set holds skill.source.read', () => {
    const { optionIds, unmount } = mountPalette({ keys: SKILLS_KEYS })

    expect(optionIds()).toContain('skills')
    unmount()
  })

  test('AC-10: it navigates to /admin/skills when activated', () => {
    const { activate, navigated, unmount } = mountPalette({ keys: SKILLS_KEYS })

    activate('skills')

    expect(navigated).toEqual(['/admin/skills'])
    unmount()
  })

  test('AC-10: an empty set lists no skills command', () => {
    const { optionIds, unmount } = mountPalette({ keys: [] })

    expect(optionIds()).not.toContain('skills')
    unmount()
  })

  test('AC-10 (edge): an ADMIN role with an empty set still gets no skills command', () => {
    const { optionIds, unmount } = mountPalette({ role: 'ADMIN', keys: [] })

    expect(optionIds()).not.toContain('skills')
    unmount()
  })

  test('AC-10 (edge): an unrelated key does not unlock the command', () => {
    const { optionIds, unmount } = mountPalette({ keys: ['user.read', 'fleet.dashboard.read'] })

    expect(optionIds()).not.toContain('skills')
    unmount()
  })

  test('AC-10 (control): an empty set still offers the dashboard entry', () => {
    const { optionIds, unmount } = mountPalette({ keys: [] })

    expect(optionIds()).toContain('dashboard')
    unmount()
  })

  test('AC-12: while /me/permissions is pending the skills command stays hidden', () => {
    const { optionIds, unmount } = mountPalette({ keys: SKILLS_KEYS, pending: true })

    expect(optionIds()).not.toContain('skills')
    unmount()
  })
})
