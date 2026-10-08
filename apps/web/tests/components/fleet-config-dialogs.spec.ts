import { describe, expect, test } from '@jest/globals'
import * as protocol from '@nathapp/fleet-protocol'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FakeNode } from '../helpers/mount-sfc'

const alias = { '@nathapp/fleet-protocol': protocol }
const globals = { useI18n: () => enI18n() }
const mount = (file: string, props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'config', file), { props, globals, alias, components: uiStubs })
const click = (n: FakeNode | undefined): void => { (n?.props.onClick as () => void)() }
const type = (n: FakeNode | undefined, value: string): void => { (n?.props['onUpdate:modelValue'] as (v: string) => void)(value) }
// Vue re-renders through its scheduler (a microtask), so assertions on post-typing state must let it
// flush first — same pattern as fleet-budget-edit-dialog.spec.ts and fleet-ticket-picker.spec.ts.
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('NaxChangesPanel', () => {
  const draft = {
    baseSha: 'b',
    files: {
      '.nax/context.md': { path: '.nax/context.md', baseSha: 's', original: 'a\nb', content: 'a\nX', conflict: false },
      '.nax/rules/n.md': { path: '.nax/rules/n.md', baseSha: null, original: null, content: 'new', conflict: true },
    },
  }

  test('one block per file with +/- lines, conflict badge and resolve; discard emits per file and for all', () => {
    const app = mount('NaxChangesPanel.vue', { draft, readonly: false })
    const blocks = app.find('[data-testid="nax-change"]')
    expect(blocks.map((b) => b.props['data-path'])).toEqual(['.nax/context.md', '.nax/rules/n.md'])
    expect(app.find('[data-testid="nax-diff-line"]', blocks[0]).map((l) => [l.props['data-kind'], app.textOf(l).trim()])).toEqual([
      ['same', 'a'], ['del', '- b'], ['add', '+ X'],
    ])
    expect(app.find('[data-testid="nax-change-conflict"]', blocks[1])).toHaveLength(1)
    click(app.find('[data-testid="nax-change-resolve"]', blocks[1])[0])
    click(app.find('[data-testid="nax-change-discard"]', blocks[0])[0])
    click(app.one('[data-testid="nax-changes-discard-all"]'))
    expect(app.emitted('resolve')).toEqual([['.nax/rules/n.md']])
    expect(app.emitted('discard')).toEqual([['.nax/context.md']])
    expect(app.emitted('discardAll')).toEqual([[]])
  })

  test('read-only hides every action', () => {
    const app = mount('NaxChangesPanel.vue', { draft, readonly: true })
    expect(app.find('[data-testid="nax-change-discard"]')).toHaveLength(0)
    expect(app.find('[data-testid="nax-changes-discard-all"]')).toHaveLength(0)
  })
})

describe('ConfigPrDialog', () => {
  test('submit is disabled until a title is typed; it emits trimmed title and the description', async () => {
    const app = mount('ConfigPrDialog.vue', { open: true, mode: 'edit', busy: false })
    const submit = (): FakeNode | undefined => app.one('[data-testid="config-pr-submit"]')
    expect(submit()?.props.disabled).toBe(true)
    type(app.one('[data-testid="config-pr-title"]'), '  Tighten rules  ')
    type(app.one('[data-testid="config-pr-body"]'), 'why')
    await flush()
    expect(submit()?.props.disabled).toBe(false)
    click(submit())
    expect(app.emitted('submit')).toEqual([[{ prTitle: 'Tighten rules', prBody: 'why' }]])
  })

  test('a title over 200 characters or a description over 8 KiB blocks submit with a message', async () => {
    const app = mount('ConfigPrDialog.vue', { open: true, mode: 'regenerate', busy: false })
    type(app.one('[data-testid="config-pr-title"]'), 'x'.repeat(201))
    await flush()
    expect(app.one('[data-testid="config-pr-submit"]')?.props.disabled).toBe(true)
    expect(app.one('[data-testid="config-pr-error"]')).toBeDefined()
    type(app.one('[data-testid="config-pr-title"]'), 'ok')
    type(app.one('[data-testid="config-pr-body"]'), 'y'.repeat(8193))
    await flush()
    expect(app.one('[data-testid="config-pr-submit"]')?.props.disabled).toBe(true)
  })

  test('the regenerate mode has its own title', () => {
    const app = mount('ConfigPrDialog.vue', { open: true, mode: 'regenerate', busy: false })
    expect(app.text()).toContain('Open regenerate PR')
  })
})

describe('NewNaxFileDialog', () => {
  test('a suggestion fills the path; create emits only for an allowed, unused path', () => {
    const app = mount('NewNaxFileDialog.vue', { open: true, targets: ['.nax/rules/new-rule.md', '.nax/config.json'], existing: ['.nax/context.md'] })
    click(app.find('[data-testid="new-file-target"]')[1])
    click(app.one('[data-testid="new-file-create"]'))
    expect(app.emitted('create')).toEqual([['.nax/config.json']])
  })

  test('a disallowed or existing path shows an error and disables create', async () => {
    const app = mount('NewNaxFileDialog.vue', { open: true, targets: [], existing: ['.nax/context.md'] })
    type(app.one('[data-testid="new-file-path"]'), '.nax/profiles/p.env')
    await flush()
    expect(app.one('[data-testid="new-file-create"]')?.props.disabled).toBe(true)
    expect(app.text()).toContain('not a path the editor can create')
    type(app.one('[data-testid="new-file-path"]'), '.nax/context.md')
    await flush()
    expect(app.text()).toContain('already exists')
  })
})
