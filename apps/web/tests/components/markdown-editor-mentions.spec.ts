import { describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { ref } from 'vue'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { ProjectMember } from '~/composables/useProjectMembers'

const editor = webFile('components', 'MarkdownEditor.vue')
const ID = 'c000000000000000000000001'
const MEMBERS: ProjectMember[] = [
  { userId: ID, name: 'Ann Lee', email: 'ann@x.io', role: 'DEVELOPER', joinedAt: '' },
  { userId: 'c000000000000000000000002', name: 'Bo', email: 'bo@x.io', role: 'VIEWER', joinedAt: '' },
]

function mount(props: Record<string, unknown>) {
  const members = ref<ProjectMember[]>([])
  const load = jest.fn(async () => { members.value = MEMBERS })
  const namesCalls: string[] = []
  const app = mountSfc(editor, {
    components: uiStubs,
    props,
    alias: {
      '~/components/ui/tabs': { Tabs: uiStubs.Tabs, TabsList: uiStubs.TabsList, TabsTrigger: uiStubs.TabsTrigger, TabsContent: uiStubs.TabsContent },
      '~/components/ui/textarea': { Textarea: uiStubs.Textarea },
      // The preview renderer pulls isomorphic-dompurify (ESM) that this Jest setup cannot load; the picker does not need it.
      '~/lib/markdown': { renderMarkdownOrEscape: (text: string) => text },
    },
    globals: {
      useI18n: () => enI18n(),
      useProjectMemberNames: (slug: string) => { namesCalls.push(slug); return { members, load, nameOf: () => null } },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await Vue.nextTick()
    }
  }
  const textarea = () => app.find('[data-stub="textarea"]')[0]
  const type = (value: string, caret = value.length) =>
    (textarea().props.onInput as (e: unknown) => void)({ target: { value, selectionStart: caret, focus: () => undefined, setSelectionRange: () => undefined } })
  return { app, load, namesCalls, settle, textarea, type, byId: (id: string) => app.find(`[data-testid="${id}"]`) }
}

describe('MarkdownEditor @mentions (S4a §5)', () => {
  test('without mentionSlug there is no picker and no member lookup', async () => {
    const m = mount({ modelValue: '' })
    m.type('hi @a')
    await m.settle()
    expect(m.namesCalls).toEqual([])
    expect(m.byId('mention-picker')).toHaveLength(0)
    expect(m.app.emitted('update:modelValue')).toEqual([['hi @a']])
  })

  test('typing @ loads members once and lists matches', async () => {
    const m = mount({ modelValue: '', mentionSlug: 'koda' })
    m.type('hi @')
    await m.settle()
    m.type('hi @an')
    await m.settle()
    expect(m.namesCalls).toEqual(['koda'])
    expect(m.load).toHaveBeenCalledTimes(1)
    const options = m.byId('mention-option')
    expect(options).toHaveLength(1)
    expect(m.app.textOf(options[0])).toContain('Ann Lee')
  })

  test('choosing a member replaces @query with the token', async () => {
    const m = mount({ modelValue: 'hi @an', mentionSlug: 'koda' })
    m.type('hi @an')
    await m.settle()
    ;(m.byId('mention-option')[0].props.onMousedown as (e: unknown) => void)({ preventDefault: () => undefined })
    await m.settle()
    expect(m.app.emitted('update:modelValue').at(-1)).toEqual([`hi @[Ann Lee](user:${ID}) `])
    expect(m.byId('mention-picker')).toHaveLength(0)
  })

  test('a space after the query or Escape closes the picker', async () => {
    const m = mount({ modelValue: '', mentionSlug: 'koda' })
    m.type('hi @an')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(1)
    m.type('hi @an ')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(0)
    m.type('hi @b')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(1)
    ;(m.textarea().props.onKeydown as (e: unknown) => void)({ key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined })
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(0)
  })

  test('a failed member load shows no picker and retries on the next @', async () => {
    const m = mount({ modelValue: '', mentionSlug: 'koda' })
    m.load.mockRejectedValueOnce(new Error('403'))
    m.type('@')
    await m.settle()
    expect(m.byId('mention-picker')).toHaveLength(0)
    m.type('@a')
    await m.settle()
    expect(m.load).toHaveBeenCalledTimes(2)
  })
})

describe('mention-slug wiring and chip rendering', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '../..', ...parts), 'utf-8')

  test('comment box, comment edit, description editor and create dialog pass the project slug', () => {
    expect(read('components', 'CommentThread.vue').match(/:mention-slug="projectSlug"/g)).toHaveLength(2)
    expect(read('components', 'TicketActivity.vue')).toContain(':mention-slug="projectSlug"')
    expect(read('components', 'CreateTicketDialog.vue')).toContain(':mention-slug="props.projectSlug"')
  })

  test('comments render tokens as chips without v-html; descriptions run through withMentionChips', () => {
    const thread = read('components', 'CommentThread.vue')
    expect(thread).toContain('splitMentions(comment.body)')
    expect(thread).toContain('class="mention-chip"')
    expect(thread).not.toMatch(/v-html="[^"]*comment/)
    expect(read('components', 'TicketActivity.vue')).toContain('renderMarkdownOrEscape(withMentionChips(')
  })

  test('keyboard: ArrowDown/ArrowUp move the active option, Enter picks it, aria-activedescendant follows (review fix)', async () => {
    const m = mount({ modelValue: 'hi @', mentionSlug: 'koda' })
    m.type('hi @')
    await m.settle()
    const key = (k: string) => {
      const e = { key: k, preventDefault: jest.fn(), stopPropagation: jest.fn(), target: { value: 'hi @', selectionStart: 4 } }
      ;(m.textarea().props.onKeydown as (ev: unknown) => void)(e)
      return e
    }
    expect(m.byId('mention-option')).toHaveLength(2)
    expect(String(m.textarea().props['aria-activedescendant'])).toContain('-0')
    key('ArrowDown')
    await m.settle()
    expect(String(m.textarea().props['aria-activedescendant'])).toContain('-1')
    key('ArrowDown') // wraps
    key('ArrowUp')   // back to 1
    await m.settle()
    const enter = key('Enter')
    await m.settle()
    expect(enter.preventDefault).toHaveBeenCalled()
    expect(m.app.emitted('update:modelValue').at(-1)).toEqual(['hi @[Bo](user:c000000000000000000000002) '])
    expect(m.byId('mention-picker')).toHaveLength(0)
  })

  test('Enter and Escape behave normally when no picker is shown (review fix)', async () => {
    const m = mount({ modelValue: 'plain', mentionSlug: 'koda' })
    m.type('plain')
    await m.settle()
    const e = { key: 'Enter', preventDefault: jest.fn(), stopPropagation: jest.fn(), target: {} }
    ;(m.textarea().props.onKeydown as (ev: unknown) => void)(e)
    const esc = { key: 'Escape', preventDefault: jest.fn(), stopPropagation: jest.fn(), target: {} }
    ;(m.textarea().props.onKeydown as (ev: unknown) => void)(esc)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(esc.stopPropagation).not.toHaveBeenCalled()
  })

  test('after picking, the caret lands right after the inserted token, not at the end (review fix)', async () => {
    const m = mount({ modelValue: 'hi @an and more', mentionSlug: 'koda' })
    const el = { value: 'hi @an and more', selectionStart: 6, setSelectionRange: jest.fn(), focus: jest.fn() }
    ;(m.textarea().props.onInput as (e: unknown) => void)({ target: el })
    await m.settle()
    ;(m.byId('mention-option')[0].props.onMousedown as (e: unknown) => void)({ preventDefault: () => undefined })
    await m.settle()
    const token = `@[Ann Lee](user:${ID}) `
    expect(m.app.emitted('update:modelValue').at(-1)).toEqual([`hi ${token} and more`])
    expect(el.setSelectionRange).toHaveBeenCalledWith(3 + token.length, 3 + token.length)
    expect(el.focus).toHaveBeenCalled()
  })
})

