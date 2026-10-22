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
 * US-005 AC-14 (fleet S5b 1d): the palette's `my-threads` command — the personal thread list is a
 * top-level destination, so it must be offered with or without a project slug.
 *
 * Same harness as tests/components/command-palette-threads.spec.ts: the palette's search box uses
 * `v-model`, which the fake renderer cannot host, so the spec mounts a copy whose only change is
 * `v-model="query"` becoming `:value="query"`.
 */
const realPalette = webFile('components', 'CommandPalette.vue')

const scratch = mkdtempSync(join(tmpdir(), 'palette-my-threads-'))
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
  activate: (id: string) => void
  navigated: string[]
  unmount: () => void
}

/** Mounts the real palette, opened, for a viewer with the given project slug (or none). */
function mountPalette(projectSlug: string | undefined): Mounted {
  const navigated: string[] = []
  const app = mountSfc(paletteCopy, {
    props: { open: true, projectSlug },
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
      useAuth: () => ({ user: ref({ email: 'a@k.t', role: 'MEMBER' }) }),
      // US-006: the palette's Skills entry reads the global permission set; this viewer holds none.
      useGlobalPermissions: () => globalPermissionsStub(),
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

describe('US-005 AC-14: the command palette My threads entry', () => {
  test('AC-14: without a project slug the palette offers my-threads and activating it opens /threads', () => {
    const { optionIds, activate, navigated, unmount } = mountPalette(undefined)

    expect(optionIds()).toContain('my-threads')
    activate('my-threads')
    expect(navigated).toEqual(['/threads'])
    unmount()
  })

  test('AC-14: with project slug web the palette still offers my-threads and activating it opens /threads', () => {
    const { optionIds, activate, navigated, unmount } = mountPalette('web')

    expect(optionIds()).toContain('my-threads')
    activate('my-threads')
    expect(navigated).toEqual(['/threads'])
    unmount()
  })

  test('AC-14 (edge): the project threads entry keeps its own id and path', () => {
    const { optionIds, activate, navigated, unmount } = mountPalette('web')

    const ids = optionIds()
    expect(ids).toContain('threads')
    expect(ids.indexOf('threads')).not.toBe(ids.indexOf('my-threads'))
    activate('threads')
    expect(navigated).toEqual(['/web/threads'])
    unmount()
  })
})
