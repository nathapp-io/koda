import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ComposerReason } from '~/lib/thread-types'

/**
 * US-007 AC1-AC4, AC6-AC7: components/fleet/threads/ThreadComposer.vue — the creator's
 * composer and the viewer's read-only note.
 *
 * Component contract (web context §4.62): props `composerState: { canSend, reason }`
 * (`reason` is a `ComposerReason`: a `ThreadSendRefusal` or `readOnly`) and
 * `turnRunning: boolean`; emits `send(text)` and `stop`. Enter sends the trimmed draft,
 * Shift+Enter inserts a newline (never sends), whitespace sends nothing, a refused
 * composerState renders the `fleet.threads.refusal.<reason>` text, a readOnly state
 * renders `fleet.threads.composer.readOnly` instead of a textarea, and a running turn
 * renders a Stop control that emits `stop`.
 *
 * The textarea is driven the same way the MarkdownEditor spec drives its textarea stub:
 * the value is typed through the input/update handler the composer binds, then Enter is
 * fired through the keydown handler. Every assertion is on the component's observable
 * contract (the emitted event, or the rendered key text through the key-returning
 * `i18nStub`), never on internals.
 */

interface ComposerState {
  canSend: boolean
  reason: ComposerReason | null
}

const composerFile = webFile('components', 'fleet', 'threads', 'ThreadComposer.vue')

const mountComposer = (composerState: ComposerState, turnRunning = false): Mounted =>
  mountSfc(composerFile, {
    props: { composerState, turnRunning },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

/** The textarea stub (or a native textarea, if the component renders one directly). */
const textarea = (app: Mounted): FakeNode | undefined =>
  app.one('[data-stub="textarea"]') ?? app.one('textarea')

/** Types `value` through whichever input binding the composer exposes on the textarea. */
function typeText(app: Mounted, value: string): void {
  const el = textarea(app)
  if (el === undefined) return
  const onInput = el.props.onInput
  const onUpdate = el.props['onUpdate:modelValue']
  if (typeof onInput === 'function') {
    (onInput as (event: { target: { value: string } }) => void)({ target: { value } })
  } else if (typeof onUpdate === 'function') {
    (onUpdate as (value: string) => void)(value)
  }
}

/** Fires Enter (or Shift+Enter) at the textarea's keydown handler, the way a browser would. */
function pressEnter(app: Mounted, shift = false): void {
  const el = textarea(app)
  if (el === undefined) return
  const onKeydown = el.props.onKeydown
  if (typeof onKeydown === 'function') {
    (onKeydown as (event: { key: string; shiftKey?: boolean; preventDefault: () => void }) => void)({
      key: 'Enter',
      shiftKey: shift,
      preventDefault: () => undefined,
    })
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

describe('US-007 AC1-AC4, AC6-AC7: ThreadComposer', () => {
  test('AC1: pressing Enter in a textarea holding hello emits send with hello', async () => {
    const app = mountComposer({ canSend: true, reason: null })

    typeText(app, 'hello')
    pressEnter(app)
    await settle()

    expect(app.emitted('send')).toEqual([['hello']])
    app.unmount()
  })

  test('AC2: pressing Shift+Enter inserts a newline and emits no send', async () => {
    const app = mountComposer({ canSend: true, reason: null })

    typeText(app, 'hello')
    pressEnter(app, true)
    await settle()

    expect(app.emitted('send')).toEqual([])
    // The draft holds the newline (US-007: "Shift+Enter inserts a newline"), so a later
    // Enter sends the multi-line text rather than nothing. The stub forwards the
    // `model-value` attr kebab-cased (the fake renderer's patchProp key).
    expect(textarea(app)?.props['model-value']).toBe('hello\n')
    typeText(app, 'hello\nworld')
    pressEnter(app)
    await settle()
    expect(app.emitted('send')).toEqual([['hello\nworld']])
    app.unmount()
  })

  test('AC3: pressing Enter in a whitespace-only textarea emits no send', async () => {
    const app = mountComposer({ canSend: true, reason: null })

    typeText(app, '   ')
    pressEnter(app)
    await settle()

    expect(app.emitted('send')).toEqual([])
    app.unmount()
  })

  test('US-007: a draft over 32768 UTF-8 bytes emits no send and shows the tooLong error', async () => {
    const app = mountComposer({ canSend: true, reason: null })

    typeText(app, 'é'.repeat(16_385)) // 32_770 bytes — past the API's messageMaxBytes limit
    pressEnter(app)
    await settle()

    expect(app.emitted('send')).toEqual([])
    expect(app.text()).toContain('fleet.threads.message.tooLong')
    app.unmount()
  })

  test('AC4: composerState refusing with reason closing shows the fleet.threads.refusal.closing text', () => {
    const app = mountComposer({ canSend: false, reason: 'closing' })

    expect(app.text()).toContain('fleet.threads.refusal.closing')
    app.unmount()
  })

  test('AC6: a readOnly composer shows fleet.threads.composer.readOnly and renders no textarea', () => {
    const app = mountComposer({ canSend: false, reason: 'readOnly' })

    expect(app.text()).toContain('fleet.threads.composer.readOnly')
    expect(textarea(app)).toBeUndefined()
    app.unmount()
  })

  test('AC7: with turnRunning true, clicking Stop emits stop', async () => {
    const app = mountComposer({ canSend: true, reason: null }, true)

    const stop = actionButton(app, 'fleet.threads.composer.stop')
    expect(stop).toBeDefined()
    if (stop === undefined) {
      app.unmount()
      return
    }
    (stop.props.onClick as () => void)()
    await settle()

    expect(app.emitted('stop')).toEqual([[]])
    app.unmount()
  })
})