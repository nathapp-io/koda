import { describe, expect, test } from '@jest/globals'
import { FILTER_CONTROL_CLASS } from '../../lib/form-control'
import { mountSfc, webFile } from '../helpers/mount-sfc'

describe('FILTER_CONTROL_CLASS', () => {
  test('exports the shared input-height class', () => {
    expect(FILTER_CONTROL_CLASS).toBe('h-10 rounded-md border border-input bg-background px-3 text-sm')
  })

  test('FleetNativeSelect uses the shared class with full width', () => {
    const mounted = mountSfc(webFile('components', 'fleet', 'NativeSelect.vue'), { props: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } })
    const classes = String(mounted.one('select')?.props.class)
    expect(classes).toContain('h-10')
    expect(classes).toContain('w-full')
    expect(classes).not.toContain('h-9')
    mounted.unmount()
  })

  test('native change with no target still emits the empty string', () => {
    const mounted = mountSfc(webFile('components', 'fleet', 'NativeSelect.vue'), { props: { options: [] } })
    ;(mounted.one('select')?.props.onChange as (event: unknown) => void)({ target: null })
    expect(mounted.emitted('update:modelValue')).toEqual([['']])
    mounted.unmount()
  })
})
