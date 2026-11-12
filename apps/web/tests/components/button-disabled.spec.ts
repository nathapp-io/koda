import { describe, expect, test } from '@jest/globals'
import { loadSfc, mountSfc, webFile } from '../helpers/mount-sfc'
import { i18nStub, uiStubs } from '../helpers/fleet-harness'
import type { ThreadDetailDto } from '~/lib/thread-types'

const Button = loadSfc(webFile('components', 'ui', 'button', 'Button.vue'))

const thread = (over: Record<string, unknown> = {}): ThreadDetailDto => ({
  id: 't', repoId: 'r', baseRef: 'main', feature: 'f', title: 'title', createdById: 'u', runnerId: 'r',
  backend: { kind: 'native', model: 'x' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5',
  costUsd: '0', tokens: null, specPath: 'spec.md', pendingQuestion: null, session: null, lastActivityAt: '',
  createdAt: '', activeJob: null, sendRefusal: null, writtenPaths: ['a.md'], publishedSha: null,
  specPublished: true, lastWrite: null, handoff: { plan: null, run: null }, ...over,
})

const mountButton = (variant: string) => mountSfc(webFile('components', 'ui', 'button', 'Button.vue'), {
  props: { variant, disabled: true },
})

const mountActionBar = (value: ThreadDetailDto) => mountSfc(webFile('components', 'fleet', 'threads', 'ThreadActionBar.vue'), {
  props: { thread: value, messages: [], isCreator: true },
  components: {
    ...uiStubs,
    Button,
    FleetThreadsThreadPublishDialog: { template: '<div />' },
    FleetThreadsThreadHandoffDialog: { template: '<div />' },
  },
  globals: { useI18n: () => i18nStub() },
})

describe('disabled button styling and thread action reasons', () => {
  test('AC-1 default disabled button has muted disabled classes instead of opacity', () => {
    const app = mountButton('default')
    const classes = String(app.one('button')?.props.class)
    expect(classes).toContain('disabled:bg-muted')
    expect(classes).toContain('disabled:text-muted-foreground')
    expect(classes).toContain('disabled:opacity-100')
    expect(classes).not.toContain('disabled:opacity-50')
    app.unmount()
  })

  test('AC-2 destructive disabled button has muted disabled classes', () => {
    const app = mountButton('destructive')
    const classes = String(app.one('button')?.props.class)
    expect(classes).toContain('disabled:bg-muted')
    expect(classes).toContain('disabled:text-muted-foreground')
    expect(classes).toContain('disabled:opacity-100')
    app.unmount()
  })

  test('AC-3 outline disabled button retains half opacity without muted fill', () => {
    const app = mountButton('outline')
    const classes = String(app.one('button')?.props.class)
    expect(classes).toContain('disabled:opacity-50')
    expect(classes).not.toContain('disabled:bg-muted')
    app.unmount()
  })

  test('AC-4 blocked Publish reason is a paragraph under its button in the same flex column', () => {
    const app = mountActionBar(thread({ writtenPaths: [] }))
    const button = app.one('[data-testid="thread-action-publish"]')
    const reason = app.one('[data-testid="thread-action-publish-reason"]')
    expect(reason?.tag).toBe('p')
    expect(String(reason?.props.class).split(/\s+/)).toEqual(expect.arrayContaining(['text-xs', 'text-muted-foreground']))
    expect(button?.parent).toBe(reason?.parent)
    expect(button?.parent?.props.class).toContain('flex-col')
    expect(button?.parent?.children.indexOf(button!)).toBeLessThan(button?.parent?.children.indexOf(reason!) ?? -1)
    app.unmount()
  })

  test('AC-5 blocked Publish button describes its reason by id', () => {
    const app = mountActionBar(thread({ writtenPaths: [] }))
    const button = app.one('[data-testid="thread-action-publish"]')
    const reason = app.one('[data-testid="thread-action-publish-reason"]')
    expect(reason?.props.id).toBe('thread-action-publish-reason')
    expect(button?.props['aria-describedby']).toBe('thread-action-publish-reason')
    app.unmount()
  })

  test('AC-6 ask-mode Publish has no described-by when it has no reason', () => {
    const app = mountActionBar(thread({ mode: 'ask', writtenPaths: [] }))
    const button = app.one('[data-testid="thread-action-publish"]')
    expect(button?.props.disabled).toBe(false)
    expect(button?.props['aria-describedby']).toBeUndefined()
    expect(app.one('[data-testid="thread-action-publish-reason"]')).toBeUndefined()
    app.unmount()
  })
})
