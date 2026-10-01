import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mountSfc } from '../helpers/mount-sfc'

const file = join(__dirname, '../..', 'components', 'fleet', 'NativeSelect.vue')
const options = [{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }]

// vee-validate's FormField hands this exact shape to its slot as `componentField`.
function componentField(value: string) {
  return { modelValue: value, 'onUpdate:modelValue': jest.fn(), onBlur: jest.fn() }
}

describe('FleetNativeSelect binds vee-validate componentField', () => {
  test('a native change reaches onUpdate:modelValue with the chosen value', () => {
    const field = componentField('github')
    const { find } = mountSfc(file, { ...field, options, testid: 'fleet-repo-provider' })
    const [select] = find('select')

    ;(select.props.onChange as (e: unknown) => void)({ target: { value: 'gitlab' } })

    expect(field['onUpdate:modelValue']).toHaveBeenCalledWith('gitlab')
  })

  test('blur reaches onBlur', () => {
    const field = componentField('github')
    const { find } = mountSfc(file, { ...field, options })
    const event = { type: 'blur' }

    ;(find('select')[0].props.onBlur as (e: unknown) => void)(event)

    expect(field.onBlur).toHaveBeenCalledWith(event)
  })

  test('the select shows modelValue and never leaks modelValue as an attribute', () => {
    const { find } = mountSfc(file, { ...componentField('gitlab'), options, testid: 'fleet-repo-provider' })
    const [select] = find('select')

    expect(select.props.value).toBe('gitlab')
    expect(select.props['data-testid']).toBe('fleet-repo-provider')
    expect(Object.keys(select.props)).not.toContain('modelValue')
    expect(find('option').map((o) => o.props.value)).toEqual(['github', 'gitlab'])
  })

  test('a placeholder renders a disabled empty first option', () => {
    const { find } = mountSfc(file, { ...componentField(''), options, placeholder: 'Choose' })
    const [first] = find('option')

    expect(first.props.value).toBe('')
    expect(first.props.disabled).toBe('')
  })

  test('the SFC imports nothing but vue (the mount helper only provides vue)', () => {
    const source = readFileSync(file, 'utf-8')
    expect(source).not.toMatch(/from '(?!vue')/)
  })
})
