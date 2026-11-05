import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs } from '../helpers/fleet-harness'
import { createThreadController } from '~/lib/thread-controller'
import type { ThreadApprovalDelivery, ThreadDetailDto, ThreadPendingApprovalDto } from '~/lib/thread-types'

/**
 * thread-agents-modes US-012 AC-6..AC-9, AC-12: components/fleet/threads/ThreadApprovalCard.vue — one answerable
 * session approval.
 *
 * The card is handed the shared thread controller's `decideApproval`, so the transport under assertion is the real one:
 * `POST /projects/<slug>/threads/<id>/approvals/<requestId>` with `{ decision }`, where Approve maps to `allow` and Deny
 * to `deny` (US-008). Every textual field is runner/agent text and renders through `{{ }}` interpolation only.
 */

const cardFile = webFile('components', 'fleet', 'threads', 'ThreadApprovalCard.vue')

const enLocale = require('../../i18n/locales/en.json') as Record<string, unknown>
const zhLocale = require('../../i18n/locales/zh.json') as Record<string, unknown>

/** An i18n stub resolving against a real locale tree, interpolating `{name}` placeholders. */
function localeI18n(tree: Record<string, unknown>) {
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree)
  return {
    t: (key: string, named: Record<string, unknown> = {}): string => {
      const value = lookup(key)
      if (typeof value !== 'string') return key
      return value.replace(/\{(\w+)\}/g, (match, name: string) => (name in named ? String(named[name]) : match))
    },
    te: (key: string): boolean => lookup(key) !== undefined,
  }
}

const approval = (over: Partial<ThreadPendingApprovalDto> = {}): ThreadPendingApprovalDto => ({
  requestId: 'req1',
  tool: 'bash',
  summary: 'Run the migration against the dev database',
  command: 'bun run db:migrate',
  reason: 'The schema changed in this turn',
  expiresAt: '2026-10-14T10:10:00.000Z',
  ...over,
})

const thread = (over: Partial<ThreadDetailDto> = {}): ThreadDetailDto => ({
  id: 'th1',
  kind: 'REPO',
  repoId: 'r1',
  baseRef: 'main',
  feature: 'add-auth',
  title: 'Auth spec',
  createdById: 'u1',
  runnerId: 'rn1',
  backend: { kind: 'native', model: 'gpt-5' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: null,
  pendingQuestion: null,
  session: null,
  lastActivityAt: '2026-10-14T00:00:00.000Z',
  createdAt: '2026-10-14T00:00:00.000Z',
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  mode: 'ask',
  pendingApprovals: [approval()],
  ...over,
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

/** Mounts the card over the REAL thread controller (fake `$api`), so a click reaches the path and body a browser sends. */
function mountCard(over: {
  approval?: ThreadPendingApprovalDto
  canDecide?: boolean
  locale?: 'en' | 'zh'
  postError?: unknown
} = {}) {
  const get = jest.fn(async () => thread())
  const post = jest.fn(async () => {
    if (over.postError !== undefined) throw over.postError
    return {}
  })
  const patch = jest.fn(async () => ({}))
  const controller = createThreadController({
    api: { get, post, patch },
    slug: 'acme',
    threadId: 'th1',
    openStream: () => ({ close: () => undefined }),
    setTimer: () => 0,
    clearTimer: () => undefined,
    now: () => 0,
  })
  const app = mountSfc(cardFile, {
    props: {
      approval: over.approval ?? approval(),
      canDecide: over.canDecide ?? true,
      decide: controller.decideApproval,
    },
    components: uiStubs,
    globals: { useI18n: () => localeI18n(over.locale === 'zh' ? zhLocale : enLocale) },
  })
  const byId = (id: string): ReturnType<typeof app.one> => app.one(`[data-testid="${id}"]`)
  return {
    app,
    post,
    byId,
    textOf: (id: string): string => {
      const found = byId(id)
      return found === undefined ? '' : app.textOf(found)
    },
    click: (id: string): unknown => {
      const found = byId(id)
      const onClick = found?.props.onClick
      if (typeof onClick === 'function') return (onClick as () => unknown)()
    },
    disabled: (id: string): unknown => byId(id)?.props.disabled,
  }
}

describe('US-012 AC-6..AC-9, AC-12: ThreadApprovalCard', () => {
  test('AC-6: renders the request tool, summary, command and reason', async () => {
    const m = mountCard()
    await settle()

    expect(m.textOf('thread-approval-tool')).toBe('bash')
    expect(m.textOf('thread-approval-summary')).toBe('Run the migration against the dev database')
    expect(m.textOf('thread-approval-command')).toContain('bun run db:migrate')
    expect(m.textOf('thread-approval-reason')).toContain('The schema changed in this turn')
    m.app.unmount()
  })

  test('AC-6 (text only): a summary carrying <img src=x> renders as literal text and creates no element', async () => {
    const m = mountCard({ approval: approval({ summary: 'Delete <img src=x onerror="boom()"> now' }) })
    await settle()

    expect(m.textOf('thread-approval-summary')).toBe('Delete <img src=x onerror="boom()"> now')
    expect(m.app.find('img')).toHaveLength(0)
    m.app.unmount()
  })

  test('AC-7: unsandboxed true renders the Unsandboxed badge', async () => {
    const m = mountCard({ approval: approval({ unsandboxed: true }) })
    await settle()

    expect(m.textOf('thread-approval-unsandboxed')).toBe('Unsandboxed')
    m.app.unmount()
  })

  test('AC-7 (control): a request without unsandboxed renders no badge', async () => {
    const m = mountCard()
    await settle()

    expect(m.byId('thread-approval-unsandboxed')).toBeUndefined()
    m.app.unmount()
  })

  test("AC-8: Approve posts { decision: allow } to the approval endpoint of its own request id", async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-42' }) })
    await settle()

    m.click('thread-approval-approve')
    await settle()

    expect(m.post).toHaveBeenCalledTimes(1)
    expect(m.post).toHaveBeenCalledWith('/projects/acme/threads/th1/approvals/req-42', { decision: 'allow' })
    m.app.unmount()
  })

  test("AC-9: Deny posts { decision: deny } to the approval endpoint of its own request id", async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-42' }) })
    await settle()

    m.click('thread-approval-deny')
    await settle()

    expect(m.post).toHaveBeenCalledTimes(1)
    expect(m.post).toHaveBeenCalledWith('/projects/acme/threads/th1/approvals/req-42', { decision: 'deny' })
    m.app.unmount()
  })

  test('a non-creator sees the request but no decision controls', async () => {
    const m = mountCard({ canDecide: false })
    await settle()

    expect(m.textOf('thread-approval-tool')).toBe('bash')
    expect(m.byId('thread-approval-approve')).toBeUndefined()
    expect(m.byId('thread-approval-deny')).toBeUndefined()
    expect(m.textOf('thread-approval-awaiting')).toBe("Waiting for the thread's creator to decide.")
    m.app.unmount()
  })

  test('a refused decision renders the API message and keeps both controls usable', async () => {
    const m = mountCard({ postError: { data: { message: 'This request is no longer pending.' } } })
    await settle()

    m.click('thread-approval-approve')
    await settle()

    expect(m.textOf('thread-approval-error')).toBe('This request is no longer pending.')
    expect(m.disabled('thread-approval-approve')).toBe(false)
    expect(m.disabled('thread-approval-deny')).toBe(false)
    m.app.unmount()
  })

  // Branch fix B3: a 200 only means the decision was queued; the runner may reject it and the request stays pending.
  // The card must stay visible, say the decision is queued, and offer a resend — never hide an unresolved request.
  test('B3: an accepted decision keeps the card visible and marks it queued', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7' }) })
    await settle()

    m.click('thread-approval-approve')
    await settle()

    expect(m.post).toHaveBeenCalledWith('/projects/acme/threads/th1/approvals/req-7', { decision: 'allow' })
    // The thread the fake reloads still lists the request, which is exactly the unresolved state the card must show.
    expect(m.byId('thread-approval')).toBeDefined()
    expect(m.textOf('thread-approval-queued')).toBe('Decision sent. Waiting for the session to apply it.')
    expect(m.disabled('thread-approval-approve')).toBe(true)
    expect(m.disabled('thread-approval-deny')).toBe(true)
    m.app.unmount()
  })

  test('B3: a queued decision can be sent again for a request the session has not resolved', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7' }) })
    await settle()

    m.click('thread-approval-deny')
    await settle()
    expect(m.byId('thread-approval-retry')).toBeDefined()

    m.click('thread-approval-retry')
    await settle()

    expect(m.post).toHaveBeenCalledTimes(2)
    expect(m.post).toHaveBeenLastCalledWith('/projects/acme/threads/th1/approvals/req-7', { decision: 'deny' })
    m.app.unmount()
  })

  test('B3: a retry that the API refuses clears the queued mark and shows the message', async () => {
    const m = mountCard()
    await settle()

    m.click('thread-approval-approve')
    await settle()
    expect(m.byId('thread-approval-queued')).toBeDefined()

    m.post.mockRejectedValueOnce({ data: { message: 'The session already closed.' } })
    m.click('thread-approval-retry')
    await settle()

    expect(m.textOf('thread-approval-queued')).toBe('')
    expect(m.textOf('thread-approval-error')).toBe('The session already closed.')
    expect(m.disabled('thread-approval-approve')).toBe(false)
    m.app.unmount()
  })

  // Branch fix B3 (review round 2): a 200 only means the command was QUEUED. When the runner then rejects the
  // acknowledgement, the thread keeps the request pending and its `delivery` says so; the card must stop claiming the
  // decision is queued, word the rejection, and let the person decide again.
  const rejectedDelivery = (over: Partial<ThreadApprovalDelivery> = {}): ThreadApprovalDelivery => ({
    decision: 'allow', result: 'rejected', detail: 'expired', at: '2026-10-14T10:00:00.000Z', ...over,
  })

  test('B3: an enqueue followed by a rejected acknowledgement clears the queued mark and shows the runner detail', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7' }) })
    await settle()

    m.click('thread-approval-approve')
    await settle()
    expect(m.textOf('thread-approval-queued')).toBe('Decision sent. Waiting for the session to apply it.')
    expect(m.disabled('thread-approval-approve')).toBe(true)

    // The runner's ack arrives on the thread (the page reloads it), and the request is still pending with a rejection.
    m.app.setProps({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery() }) })
    await settle()

    expect(m.byId('thread-approval-queued')).toBeUndefined()
    expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision: expired')
    expect(m.disabled('thread-approval-approve')).toBe(false)
    expect(m.disabled('thread-approval-deny')).toBe(false)
    expect(m.byId('thread-approval')).toBeDefined()
    m.app.unmount()
  })

  test.each(['API refusal', 'thrown error'] as const)(
    'B3: enqueue then runner rejection then %s on resend preserves the rejection and enables decisions',
    async (failure) => {
      const m = mountCard({ approval: approval({ requestId: 'req-7' }) })
      try {
        await settle()
        await m.click('thread-approval-approve')
        await settle()
        expect(m.byId('thread-approval-queued')).toBeDefined()

        m.app.setProps({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery() }) })
        await settle()
        expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision: expired')

        const error = { data: { message: 'The session already closed.' } }
        if (failure === 'API refusal') m.post.mockRejectedValueOnce(error)
        else m.app.setProps({ decide: async () => { throw error } })
        await settle()

        await expect(m.click('thread-approval-deny')).resolves.toBeUndefined()
        await settle()

        expect(m.textOf('thread-approval-queued')).toBe('')
        expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision: expired')
        expect(m.textOf('thread-approval-error')).toBe('The session already closed.')
        expect(m.disabled('thread-approval-approve')).toBe(false)
        expect(m.disabled('thread-approval-deny')).toBe(false)
      } finally {
        m.app.unmount()
      }
    },
  )

  test('B3: a rejection the runner gives without a detail is worded without one', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery({ detail: null }) }) })
    await settle()

    expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision.')
    expect(m.disabled('thread-approval-approve')).toBe(false)
    m.app.unmount()
  })

  test('B3: a rejection detail is runner text and renders as literal text only', async () => {
    const m = mountCard({ approval: approval({ delivery: rejectedDelivery({ detail: '<img src=x onerror="boom()">' }) }) })
    await settle()

    expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision: <img src=x onerror="boom()">')
    expect(m.app.find('img')).toHaveLength(0)
    m.app.unmount()
  })

  test('B3: an ok acknowledgement keeps the card queued until the session resolves the request', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7' }) })
    await settle()

    m.click('thread-approval-deny')
    await settle()
    m.app.setProps({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery({ decision: 'deny', result: 'ok', detail: null }) }) })
    await settle()

    expect(m.byId('thread-approval-rejected')).toBeUndefined()
    expect(m.textOf('thread-approval-queued')).toBe('Decision sent. Waiting for the session to apply it.')
    expect(m.disabled('thread-approval-deny')).toBe(true)
    m.app.unmount()
  })

  test('B3: a resend after a rejection is queued again instead of showing the previous attempt\'s outcome', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery() }) })
    await settle()
    expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision: expired')

    m.click('thread-approval-deny')
    await settle()

    expect(m.post).toHaveBeenCalledWith('/projects/acme/threads/th1/approvals/req-7', { decision: 'deny' })
    expect(m.byId('thread-approval-rejected')).toBeUndefined()
    expect(m.textOf('thread-approval-queued')).toBe('Decision sent. Waiting for the session to apply it.')
    m.app.unmount()
  })

  test('B3: a different rejection after a resend is shown as the new attempt\'s outcome', async () => {
    const m = mountCard({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery() }) })
    await settle()

    m.click('thread-approval-approve')
    await settle()
    m.app.setProps({ approval: approval({ requestId: 'req-7', delivery: rejectedDelivery({ detail: 'session_closed', at: '2026-10-14T10:05:00.000Z' }) }) })
    await settle()

    expect(m.textOf('thread-approval-rejected')).toBe('The runner did not apply the decision: session_closed')
    expect(m.byId('thread-approval-queued')).toBeUndefined()
    m.app.unmount()
  })

  test('AC-12: the Approve label is English with the English locale and Chinese with the Chinese locale', async () => {
    const en = mountCard()
    await settle()
    expect(en.textOf('thread-approval-approve')).toBe('Approve')
    en.app.unmount()

    const zh = mountCard({ locale: 'zh' })
    await settle()
    expect(zh.textOf('thread-approval-approve')).toBe('批准')
    expect(zh.textOf('thread-approval-deny')).toBe('拒绝')
    zh.app.unmount()
  })
})
