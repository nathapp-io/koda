import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { showProjectCodeNotice } from '~/lib/thread-handoff'
import type { ThreadDetailDto, ThreadSession } from '~/lib/thread-types'

/**
 * US-008 (S5b 1c-b-D16): the project-code notice.
 *
 * Placement does not require `projectCode`, so a PROJECT session on a runner without that capability
 * has no code tools; the page tells the user, exactly as it does for koda tools. The notice reads
 * `fleet.threads.projectCode.unavailable` (`{ runner }`) and only shows for a live session whose
 * `projectCodeUnavailableOn` the API set (US-003).
 */

const noticeFile = webFile('components', 'fleet', 'threads', 'ThreadProjectCodeNotice.vue')
const KEY = 'fleet.threads.projectCode.unavailable'

const enLocale = require('../../i18n/locales/en.json') as Record<string, unknown>
const zhLocale = require('../../i18n/locales/zh.json') as Record<string, unknown>

const session = (over: Partial<ThreadSession> = {}): ThreadSession => ({
  jobId: 'j1',
  state: 'live',
  resumed: false,
  contextReset: false,
  reason: null,
  at: '',
  ...over,
})

const thread = (over: Partial<ThreadDetailDto> = {}): ThreadDetailDto => ({
  id: 't',
  kind: 'PROJECT',
  repoId: null,
  baseRef: null,
  feature: null,
  title: 't',
  createdById: 'u',
  runnerId: 'r',
  backend: { kind: 'native', model: 'x' },
  status: 'ACTIVE',
  archivedAt: null,
  skills: [],
  maxCostUsd: '5',
  costUsd: '0',
  tokens: null,
  specPath: null,
  pendingQuestion: null,
  session: null,
  lastActivityAt: '',
  createdAt: '',
  activeJob: null,
  sendRefusal: null,
  writtenPaths: [],
  publishedSha: null,
  specPublished: false,
  lastWrite: null,
  handoff: { plan: null, run: null },
  ...over,
})

const mount = (t: ThreadDetailDto) =>
  mountSfc(noticeFile, {
    props: { thread: t },
    components: uiStubs,
    globals: { useI18n: () => enI18n() },
  })

/** The real message for a key from a locale tree, with `{param}` placeholders substituted. */
function message(tree: Record<string, unknown>, key: string, params: Record<string, string>): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree)
  expect(typeof value).toBe('string')
  return String(value).replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? params[name] : match))
}

describe('US-008 ThreadProjectCodeNotice', () => {
  test('AC-1: showProjectCodeNotice returns true for a live session with projectCodeUnavailableOn', () => {
    const t = thread({ session: session({ projectCodeUnavailableOn: 'wk-mac' }) })
    expect(showProjectCodeNotice(t)).toBe(true)
  })

  test.each([
    ['a closed session with projectCodeUnavailableOn', thread({ session: session({ state: 'closed', projectCodeUnavailableOn: 'wk-mac' }) })],
    ['a live session without projectCodeUnavailableOn', thread({ session: session() })],
    ['no session', thread({ session: null })],
  ])('AC-2: showProjectCodeNotice returns false for %s', (_name, t) => {
    expect(showProjectCodeNotice(t)).toBe(false)
  })

  test('AC-3: a live session with projectCodeUnavailableOn wk-mac renders thread-project-code-notice with the runner named', () => {
    const app = mount(thread({ session: session({ projectCodeUnavailableOn: 'wk-mac' }) }))
    const el = app.one('[data-testid="thread-project-code-notice"]')
    expect(el).toBeDefined()
    expect(el === undefined ? null : app.textOf(el)).toBe(
      "project code is unavailable on runner wk-mac; this session cannot read the project's repositories.",
    )
    app.unmount()
  })

  test('AC-4: a live session without projectCodeUnavailableOn renders no thread-project-code-notice element', () => {
    const app = mount(thread({ session: session() }))
    expect(app.one('[data-testid="thread-project-code-notice"]')).toBeUndefined()
    expect(app.text()).not.toContain('project code is unavailable')
    app.unmount()
  })

  test.each([['en', enLocale], ['zh', zhLocale]])(
    'AC-5: %s translates fleet.threads.projectCode.unavailable with the runner name',
    (locale, tree) => {
      const text = message(tree as Record<string, unknown>, KEY, { runner: 'wk-mac' })
      expect(text).toContain('wk-mac')
      expect(text).not.toContain('{runner}')
      if (locale === 'en') {
        expect(text).toBe(
          "project code is unavailable on runner wk-mac; this session cannot read the project's repositories.",
        )
      } else {
        expect(text).toBe('此运行器 wk-mac 上无法读取项目代码；此会话无法读取项目的代码仓库。')
      }
    },
  )
})
