import { describe, expect, test } from '@jest/globals'
import * as protocol from '@nathapp/fleet-protocol'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'

const alias = { '@nathapp/fleet-protocol': protocol }
const globals = { useI18n: () => enI18n() }
// `__esModule` is required: NaxFileEditor default-imports this module, and without the marker the
// harness's `__importDefault` wraps the wrapper, so Vue received `{ default: … }` as the component.
const mdStub = { __esModule: true as const, default: { name: 'MarkdownEditorStub', props: ['modelValue'], emits: ['update:modelValue'], template: '<div data-testid="md-editor" :data-value="modelValue" />' } }

describe('NaxFileTree', () => {
  const mount = (props: Record<string, unknown>) =>
    mountSfc(webFile('components', 'fleet', 'config', 'NaxFileTree.vue'), { props, globals, alias })

  test('renders groups in the given order with status markers and emits select', () => {
    const app = mount({
      selected: '.nax/rules/a.md',
      groups: [
        { group: 'rules', files: [{ path: '.nax/rules/a.md', status: 'modified' }, { path: '.nax/rules/b.md', status: 'unchanged' }] },
        { group: 'config', files: [{ path: '.nax/config.json', status: 'deleted' }] },
      ],
    })
    expect(app.find('[data-testid="nax-file-group"]').map((n) => n.props['data-group'])).toEqual(['rules', 'config'])
    const files = app.find('[data-testid="nax-file"]')
    expect(files.map((n) => [n.props['data-path'], n.props['data-status']])).toEqual([
      ['.nax/rules/a.md', 'modified'], ['.nax/rules/b.md', 'unchanged'], ['.nax/config.json', 'deleted'],
    ])
    expect(files[0].props['aria-current']).toBe('true')
    expect(app.find('[data-testid="nax-file-marker"]').map((n) => app.textOf(n))).toEqual(['Modified', 'Deleted'])
    ;(files[1].props.onClick as () => void)()
    expect(app.emitted('select')).toEqual([['.nax/rules/b.md']])
  })
})

describe('NaxFileEditor', () => {
  const mount = (props: Record<string, unknown>) =>
    mountSfc(webFile('components', 'fleet', 'config', 'NaxFileEditor.vue'), {
      props, globals, alias: { ...alias, '~/components/MarkdownEditor.vue': mdStub },
    })

  test('markdown files use MarkdownEditor', () => {
    const app = mount({ path: '.nax/context.md', modelValue: '# Hi', readonly: false, tooLarge: false })
    expect(app.one('[data-testid="md-editor"]')?.props['data-value']).toBe('# Hi')
  })

  test('json files use a textarea, emit input, and show the parse error while invalid', () => {
    const app = mount({ path: '.nax/config.json', modelValue: '{"a":', readonly: false, tooLarge: false })
    const area = app.one('[data-testid="nax-editor-json"]')
    expect(area?.tag).toBe('textarea')
    expect(app.one('[data-testid="nax-editor-json-error"]')).toBeDefined()
    ;(area?.props.onInput as (e: unknown) => void)({ target: { value: '{}' } })
    expect(app.emitted('update:modelValue')).toEqual([['{}']])
    const valid = mount({ path: '.nax/config.json', modelValue: '{}', readonly: false, tooLarge: false })
    expect(valid.one('[data-testid="nax-editor-json-error"]')).toBeUndefined()
  })

  test('read-only shows the text without an editor; too large shows a notice only', () => {
    const ro = mount({ path: '.nax/context.md', modelValue: 'text', readonly: true, tooLarge: false })
    expect(ro.one('[data-testid="nax-editor-readonly"]')).toBeDefined()
    expect(ro.one('[data-testid="md-editor"]')).toBeUndefined()
    const big = mount({ path: '.nax/context.md', modelValue: '', readonly: false, tooLarge: true })
    expect(big.text()).toContain('too large')
    expect(big.one('[data-testid="md-editor"]')).toBeUndefined()
  })
})
