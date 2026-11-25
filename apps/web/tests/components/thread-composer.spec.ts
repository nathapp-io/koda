import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { enI18n, i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ThreadActionResult } from '~/lib/thread-controller'
import type { ComposerReason } from '~/lib/thread-types'

/**
 * US-007 AC1-AC4, AC6-AC7: components/fleet/threads/ThreadComposer.vue — the creator's
 * composer and the viewer's read-only note.
 *
 * Component contract (web context §4.62): props `composerState: { canSend, reason }`
 * (`reason` is a `ComposerReason`: a `ThreadSendRefusal` or `readOnly`),
 * `showStop: boolean` and a `send(text)` promise callback; emits `stop` only. Enter
 * sends the trimmed draft and clears it on success, Shift+Enter inserts a newline (never
 * sends), whitespace sends nothing, a refused composerState renders the
 * `fleet.threads.refusal.<reason>` text, a readOnly state renders
 * `fleet.threads.composer.readOnly` instead of a textarea, and a running turn renders a
 * Stop control that emits `stop`.
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

const mountComposer = (
  composerState: ComposerState,
  send: (text: string) => Promise<ThreadActionResult> = async () => ({ ok: true }),
  showStop = false,
  toastError = jest.fn(),
  i18n: () => { t: (key: string, named?: Record<string, unknown>) => string; te: () => boolean } = () => i18nStub(),
): Mounted =>
  mountSfc(composerFile, {
    props: { composerState, send, showStop },
    components: uiStubs,
    globals: { useI18n: i18n, useAppToast: () => ({ error: toastError }) },
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
  test('AC-1: successful send clears the draft and does not render an error', async () => {
    const send = jest.fn(async () => ({ ok: true }))
    const app = mountComposer({ canSend: true, reason: null }, send)

    typeText(app, 'hello')
    pressEnter(app)
    await settle()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('hello')
    expect(textarea(app)?.props['model-value']).toBe('')
    expect(app.one('[data-testid="thread-composer-error"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-2: refused send preserves draft and re-enables the button', async () => {
    const send = jest.fn(async () => ({ ok: false, error: new Error('refused') }))
    const app = mountComposer({ canSend: true, reason: null }, send)
    typeText(app, 'hello')
    pressEnter(app)
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(textarea(app)?.props['model-value']).toBe('hello')
    expect(app.one('[data-testid="thread-send"]')?.props.disabled).toBe(false)
    app.unmount()
  })

  test('AC2: pressing Shift+Enter inserts a newline and emits no send', async () => {
    const send = jest.fn(async () => ({ ok: true }))
    const app = mountComposer({ canSend: true, reason: null }, send)

    typeText(app, 'hello')
    pressEnter(app, true)
    await settle()

    expect(send).not.toHaveBeenCalled()
    // The draft holds the newline (US-007: "Shift+Enter inserts a newline"), so a later
    // Enter sends the multi-line text rather than nothing. The stub forwards the
    // `model-value` attr kebab-cased (the fake renderer's patchProp key).
    expect(textarea(app)?.props['model-value']).toBe('hello\n')
    typeText(app, 'hello\nworld')
    pressEnter(app)
    await settle()
    expect(send).toHaveBeenCalledWith('hello\nworld')
    app.unmount()
  })

  test('AC-6: whitespace and over-length drafts never send; over-length shows an error', async () => {
    const send = jest.fn(async () => ({ ok: true }))
    const app = mountComposer({ canSend: true, reason: null }, send)

    typeText(app, '   ')
    pressEnter(app)
    await settle()

    expect(send).not.toHaveBeenCalled()
    typeText(app, 'é'.repeat(16_385))
    pressEnter(app)
    await settle()
    expect(send).not.toHaveBeenCalled()
    expect(app.text()).toContain('fleet.threads.message.tooLong')
    app.unmount()
  })

  test('pending-send regression: successful send preserves a newer draft entered while waiting', async () => {
    let resolveSend: ((result: { ok: boolean }) => void) | undefined
    const send = jest.fn(() => new Promise<{ ok: boolean }>((resolve) => { resolveSend = resolve }))
    const app = mountComposer({ canSend: true, reason: null }, send)
    typeText(app, 'first message')
    pressEnter(app)
    await settle()

    typeText(app, 'next draft')
    await settle()
    resolveSend?.({ ok: true })
    await settle()

    expect(send).toHaveBeenCalledTimes(1)
    expect(textarea(app)?.props['model-value']).toBe('next draft')
    app.unmount()
  })

  test('B1 regression: a draft edited while validation is pending still sends the submitted text', async () => {
    const send = jest.fn(async () => ({ ok: true }))
    const app = mountComposer({ canSend: true, reason: null }, send)

    typeText(app, 'first message')
    pressEnter(app)
    // Edited with no await in between, so the schema validation started by Enter is still pending:
    // the submission the user already requested must not be cancelled by this edit.
    typeText(app, 'next draft')
    await settle()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('first message')
    // A success for the older text must not clear the newer draft the user is typing.
    expect(textarea(app)?.props['model-value']).toBe('next draft')
    app.unmount()
  })

  test('AC-3: a pending send blocks Enter and click until it settles', async () => {
    let resolveSend: ((result: { ok: boolean }) => void) | undefined
    const send = jest.fn(() => new Promise<{ ok: boolean }>((resolve) => { resolveSend = resolve }))
    const app = mountComposer({ canSend: true, reason: null }, send)
    typeText(app, 'hello')
    pressEnter(app)
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(app.one('[data-testid="thread-send"]')?.props.disabled).toBe(true)
    pressEnter(app)
    const button = app.one('[data-testid="thread-send"]')
    if (typeof button?.props.onClick === 'function') (button.props.onClick as () => void)()
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    resolveSend?.({ ok: true })
    await settle()
    app.unmount()
  })

  test('AC-4 and AC-10: rejection preserves the draft, enables send and does not toast', async () => {
    const send = jest.fn(async () => { throw new Error('rejected') })
    const toastError = jest.fn()
    const app = mountComposer({ canSend: true, reason: null }, send, false, toastError)
    typeText(app, 'hello')
    pressEnter(app)
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(textarea(app)?.props['model-value']).toBe('hello')
    expect(app.one('[data-testid="thread-send"]')?.props.disabled).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
    app.unmount()
  })

  test('AC-5: send enabled state follows non-whitespace content', async () => {
    const app = mountComposer({ canSend: true, reason: null })
    typeText(app, 'hello')
    await settle()
    expect(app.one('[data-testid="thread-send"]')?.props.disabled).toBe(false)
    typeText(app, '   ')
    await settle()
    expect(app.one('[data-testid="thread-send"]')?.props.disabled).toBe(true)
    app.unmount()
  })

  test('AC-4: archived refusal shows only the archived text without input or Send', () => {
    const app = mountComposer({ canSend: false, reason: 'archived' })
    expect(app.text()).toContain('fleet.threads.refusal.archived')
    expect(textarea(app)).toBeUndefined()
    expect(app.one('[data-testid="thread-send"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-5: closing refusal shows its text and a disabled input', () => {
    const app = mountComposer({ canSend: false, reason: 'closing' })
    expect(app.text()).toContain('fleet.threads.refusal.closing')
    expect(textarea(app)?.props.disabled).toBe(true)
    app.unmount()
  })

  test('AC6: a readOnly composer shows fleet.threads.composer.readOnly and renders no textarea', () => {
    const app = mountComposer({ canSend: false, reason: 'readOnly' })

    expect(app.text()).toContain('fleet.threads.composer.readOnly')
    expect(textarea(app)).toBeUndefined()
    app.unmount()
  })

  test('AC7: with showStop true, clicking Stop emits stop', async () => {
    const app = mountComposer({ canSend: true, reason: null }, async () => ({ ok: true }), true)

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
describe('US-001 AC-3, AC-8: a send that waits for approval', () => {
  const REQUEST_ID = 'approval-thread.message.send'
  const pending = async (): Promise<ThreadActionResult> => ({ ok: false, pendingApproval: REQUEST_ID })

  test('AC-3: the composer shows the returned request id', async () => {
    const app = mountComposer({ canSend: true, reason: null }, jest.fn(pending), false, jest.fn(), () => enI18n())

    typeText(app, 'hello')
    pressEnter(app)
    await settle()

    const note = app.one('[data-testid="thread-composer-pending"]')
    expect(note).toBeDefined()
    expect(note ? app.textOf(note) : '').toContain(REQUEST_ID)
    // Nothing was written, so no refusal or error is shown for it.
    expect(app.one('[data-testid="thread-composer-error"]')).toBeUndefined()
    app.unmount()
  })

  test('AC-8: the draft stays editable and Send is available again', async () => {
    const send = jest.fn(pending)
    const app = mountComposer({ canSend: true, reason: null }, send)

    typeText(app, 'hello')
    pressEnter(app)
    await settle()

    expect(send).toHaveBeenCalledTimes(1)
    expect(textarea(app)?.props['model-value']).toBe('hello')
    expect(textarea(app)?.props.disabled).toBe(false)
    expect(app.one('[data-testid="thread-send"]')?.props.disabled).toBe(false)
    app.unmount()
  })

  test('the pending note is not left behind by the next executed send', async () => {
    let answer: ThreadActionResult = { ok: false, pendingApproval: REQUEST_ID }
    const send = jest.fn(async () => answer)
    const app = mountComposer({ canSend: true, reason: null }, send)

    typeText(app, 'first')
    pressEnter(app)
    await settle()
    expect(app.one('[data-testid="thread-composer-pending"]')).toBeDefined()

    answer = { ok: true }
    typeText(app, 'second')
    pressEnter(app)
    await settle()

    expect(send).toHaveBeenCalledTimes(2)
    expect(app.one('[data-testid="thread-composer-pending"]')).toBeUndefined()
    app.unmount()
  })
})
