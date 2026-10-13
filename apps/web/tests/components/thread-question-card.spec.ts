import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ThreadPendingQuestion } from '~/lib/thread-types'

/**
 * US-007 AC13-AC14: components/fleet/threads/ThreadQuestionCard.vue — the creator's
 * answer input on a pending question.
 *
 * Component contract (web context §4.62): props `question: ThreadPendingQuestion` and
 * `isCreator: boolean`; emits `answer(requestId, text)`. The card was created in US-006
 * (question text, `answer` emit declared); US-007 completes the creator answering UI:
 * a text field and a Send control, shown to the creator only — a non-creator sees the
 * question text with no answer input.
 *
 * The answer is driven the way the MarkdownEditor spec drives its fields: the value is
 * typed through the input handler, then the Send control is clicked. The assertion is
 * the emitted `answer` carrying the question's `requestId` and the typed text.
 */

const cardFile = webFile('components', 'fleet', 'threads', 'ThreadQuestionCard.vue')

const question = (over: Partial<ThreadPendingQuestion> = {}): ThreadPendingQuestion => ({
  requestId: 'q1',
  text: 'Which DB?',
  expiresAt: '2026-10-12T10:00:00Z',
  ...over,
})

const mountCard = (isCreator: boolean, q: ThreadPendingQuestion = question()): Mounted =>
  mountSfc(cardFile, {
    props: { question: q, isCreator },
    components: uiStubs,
    globals: { useI18n: () => i18nStub() },
  })

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

/** The answer field: the shadcn input stub, or a native input/textarea the card renders. */
const textField = (app: Mounted): FakeNode | undefined =>
  app.one('[data-stub="input"]') ?? app.one('input') ?? app.one('[data-stub="textarea"]') ?? app.one('textarea')

/** Types into the answer field through whatever input binding the card exposes. */
function typeAnswer(app: Mounted, value: string): void {
  const field = textField(app)
  if (field === undefined) return
  const onInput = field.props.onInput
  const onUpdate = field.props['onUpdate:modelValue']
  if (typeof onInput === 'function') {
    (onInput as (event: { target: { value: string } }) => void)({ target: { value } })
  } else if (typeof onUpdate === 'function') {
    (onUpdate as (value: string) => void)(value)
  }
}

/** Clicks the card's Send control: the (only) interactive element with an onClick handler. */
function pressSend(app: Mounted): void {
  const found: FakeNode[] = []
  const walk = (node: FakeNode): void => {
    if (typeof node.props.onClick === 'function') found.push(node)
    node.children.forEach(walk)
  }
  walk(app.root)
  if (found.length === 0) return
  ;(found[found.length - 1].props.onClick as () => void)()
}

describe('US-007 AC13-AC14: ThreadQuestionCard', () => {
  test('AC13: for the creator, typing Postgres and pressing Send emits answer with (q1, Postgres)', async () => {
    const app = mountCard(true)

    typeAnswer(app, 'Postgres')
    pressSend(app)
    await settle()

    expect(app.emitted('answer')).toEqual([['q1', 'Postgres']])
    app.unmount()
  })

  test('AC14: for a non-creator the card renders no answer input', () => {
    const app = mountCard(false)

    expect(app.text()).toContain('Which DB?')
    expect(textField(app)).toBeUndefined()
    app.unmount()
  })
})