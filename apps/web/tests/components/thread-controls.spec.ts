import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { SessionLabel } from '~/lib/thread-types'

/**
 * US-007 AC8-AC11: components/fleet/threads/ThreadControls.vue — the creator's session
 * controls and the manager's archive action.
 *
 * Component contract (web context §4.62): props `isCreator`, `canManage`,
 * `sessionLabel: SessionLabel` and `archived: boolean`; emits `endSession`,
 * `raiseCap(value: number)` and `archive`. End session is the creator's while the
 * session is live, Raise cap is the creator's (a dialog validating the cap rule), and
 * Archive is the creator's or a project manager's (not shown once archived). A viewer
 * who is neither gets none of the three.
 *
 * Controls are reached by their rendered i18n key text (the key-returning `i18nStub`),
 * exactly how the fleet component specs find their buttons. The Raise cap flow is
 * driven through the dialog: trigger click, type 8 into the dialog input, confirm.
 */

const controlsFile = webFile('components', 'fleet', 'threads', 'ThreadControls.vue')

interface ControlsProps {
  isCreator?: boolean
  canManage?: boolean
  sessionLabel?: SessionLabel
  archived?: boolean
}

const mountControls = (over: ControlsProps = {}): Mounted =>
  mountSfc(controlsFile, {
    props: {
      isCreator: over.isCreator ?? false,
      canManage: over.canManage ?? false,
      sessionLabel: over.sessionLabel ?? 'live',
      archived: over.archived ?? false,
    },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

/** The first interactive (onClick) element whose rendered text contains `key`. */
function actionButton(app: Mounted, key: string): FakeNode | undefined {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (typeof node.props.onClick === 'function' && app.textOf(node).includes(key)) found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  return found[0]
}

function click(node: FakeNode): void {
  (node.props.onClick as () => void)()
}

/** The first visible text field in the tree (the cap dialog input), shadcn stub or native. */
function textField(app: Mounted): FakeNode | undefined {
  return app.one('[data-stub="input"]') ?? app.one('input') ?? app.one('[data-stub="textarea"]')
}

const END = 'fleet.threads.controls.endSession'
const RAISE = 'fleet.threads.controls.raiseCap'
const ARCHIVE = 'fleet.threads.controls.archive'

describe('US-007 AC8-AC11: ThreadControls', () => {
  test('AC8: for the creator of a live session, clicking End session emits endSession', async () => {
    const app = mountControls({ isCreator: true, sessionLabel: 'live' })

    const end = actionButton(app, END)
    expect(end).toBeDefined()
    if (end === undefined) {
      app.unmount()
      return
    }
    click(end)
    await settle()

    expect(app.emitted('endSession')).toEqual([[]])
    app.unmount()
  })

  test('AC9: a viewer who is neither creator nor project manager sees no End session, Raise cap or Archive control', () => {
    const app = mountControls({ isCreator: false, canManage: false, sessionLabel: 'live' })

    expect(actionButton(app, END)).toBeUndefined()
    expect(actionButton(app, RAISE)).toBeUndefined()
    expect(actionButton(app, ARCHIVE)).toBeUndefined()
    app.unmount()
  })

  test('AC10: a project manager who is not the creator sees Archive but not the creator-only controls', () => {
    const app = mountControls({ isCreator: false, canManage: true, sessionLabel: 'live' })

    expect(actionButton(app, ARCHIVE)).toBeDefined()
    expect(actionButton(app, END)).toBeUndefined()
    expect(actionButton(app, RAISE)).toBeUndefined()
    app.unmount()
  })

  test('AC11: confirming the Raise cap dialog with 8 emits raiseCap with the number 8', async () => {
    const app = mountControls({ isCreator: true, sessionLabel: 'live' })

    const raise = actionButton(app, RAISE)
    expect(raise).toBeDefined()
    if (raise === undefined) {
      app.unmount()
      return
    }
    click(raise)
    await settle()

    const input = textField(app)
    expect(input).toBeDefined()
    if (input === undefined) {
      app.unmount()
      return
    }
    const onInput = input.props.onInput
    const onUpdate = input.props['onUpdate:modelValue']
    if (typeof onInput === 'function') {
      (onInput as (event: { target: { value: string } }) => void)({ target: { value: '8' } })
    } else if (typeof onUpdate === 'function') {
      (onUpdate as (value: string) => void)('8')
    }

    const confirm = actionButton(app, 'fleet.threads.controls.confirm') ?? actionButton(app, 'common.confirm')
    expect(confirm).toBeDefined()
    if (confirm === undefined) {
      app.unmount()
      return
    }
    click(confirm)
    await settle()

    expect(app.emitted('raiseCap')).toEqual([[8]])
    app.unmount()
  })
})