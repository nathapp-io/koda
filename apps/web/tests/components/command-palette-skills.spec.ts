import { describe, test, expect, jest, afterAll } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'

const realPalette = webFile('components', 'CommandPalette.vue')

/**
 * The palette's search box is a native `<input v-model>`. The fake renderer in mount-sfc cannot
 * host Vue's `vModelText` directive, which calls `addEventListener` on a real element. So this spec
 * mounts a copy of the real palette whose only change is `v-model="query"` becoming `:value="query"`.
 * The `<script setup>` (the command list and the admin gate) and the rest of the template are the
 * component's own code, untouched.
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

/** Mounts the real palette, opened, for a viewer with the given global role. */
function mountPalette(role: 'ADMIN' | 'MEMBER'): Mounted {
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

describe('CommandPalette skills entry (US-007)', () => {
  test('US-007 AC11: a global admin sees a palette entry with id skills', () => {
    const { optionIds, unmount } = mountPalette('ADMIN')

    expect(optionIds()).toContain('skills')
    unmount()
  })

  test('US-007 AC11: activating the skills entry navigates to /admin/skills', () => {
    const { activate, navigated, unmount } = mountPalette('ADMIN')

    activate('skills')

    expect(navigated).toEqual(['/admin/skills'])
    unmount()
  })

  test('US-007 AC12: a user who is not a global admin sees no palette entry with id skills', () => {
    const { optionIds, unmount } = mountPalette('MEMBER')

    expect(optionIds()).not.toContain('skills')
    unmount()
  })

  test('US-007 AC12 (control): a non-admin still sees the dashboard entry, so the missing skills entry is not a broken palette', () => {
    const { optionIds, unmount } = mountPalette('MEMBER')

    expect(optionIds()).toContain('dashboard')
    unmount()
  })
})
