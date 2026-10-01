import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const file = webFile('components', 'fleet', 'NativeSelect.vue')
const options = [{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }]

// vee-validate's FormField hands this exact shape to its slot as `componentField`.
function componentField(value: string) {
  return { modelValue: value, 'onUpdate:modelValue': jest.fn(), onBlur: jest.fn() }
}

describe('FleetNativeSelect binds vee-validate componentField', () => {
  test('a native change reaches onUpdate:modelValue with the chosen value', () => {
    const field = componentField('github')
    const { find, unmount } = mountSfc(file, { props: { ...field, options, testid: 'fleet-repo-provider' } })
    const [select] = find('select')

    ;(select.props.onChange as (e: unknown) => void)({ target: { value: 'gitlab' } })

    expect(field['onUpdate:modelValue']).toHaveBeenCalledWith('gitlab')
    unmount()
  })

  test('blur reaches onBlur', () => {
    const field = componentField('github')
    const { find, unmount } = mountSfc(file, { props: { ...field, options } })
    const event = { type: 'blur' }

    ;(find('select')[0].props.onBlur as (e: unknown) => void)(event)

    expect(field.onBlur).toHaveBeenCalledWith(event)
    unmount()
  })

  test('the select shows modelValue and never leaks modelValue as an attribute', () => {
    const { find, unmount } = mountSfc(file, { props: { ...componentField('gitlab'), options, testid: 'fleet-repo-provider' } })
    const [select] = find('select')

    expect(select.props.value).toBe('gitlab')
    expect(select.props['data-testid']).toBe('fleet-repo-provider')
    expect(Object.keys(select.props)).not.toContain('modelValue')
    expect(find('option').map((o) => o.props.value)).toEqual(['github', 'gitlab'])
    unmount()
  })

  test('a placeholder renders a disabled empty first option', () => {
    const { find, unmount } = mountSfc(file, { props: { ...componentField(''), options, placeholder: 'Choose' } })
    const [first] = find('option')

    expect(first.props.value).toBe('')
    expect(first.props.disabled).toBe('')
    unmount()
  })

  test('the select carries the id its FormLabel points at (accessible name)', () => {
    const { one, unmount } = mountSfc(file, { props: { ...componentField('github'), options, id: 'fleet-repo-project' } })

    expect(one('select')?.props.id).toBe('fleet-repo-project')
    unmount()
  })

  test('the SFC imports nothing but vue (the mount helper only provides vue)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'components', 'fleet', 'NativeSelect.vue'), 'utf-8')
    expect(source).not.toMatch(/from '(?!vue')/)
  })
})