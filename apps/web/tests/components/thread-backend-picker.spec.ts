import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FakeNode, Mounted } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'

/**
 * The native-model/effort picker of the new thread form (US-005). Contract:
 * props `models: string[]`, `model`, `effort`; emits `update:model`, `update:effort`.
 * The effort select's options are default, low, medium, high and xhigh (the default
 * renders an empty value, which toCreateThreadBody drops from the body).
 */
const file = webFile('components', 'fleet', 'threads', 'BackendPicker.vue')

const mountPicker = (props: Record<string, unknown>) => mountSfc(file, {
  props,
  globals: { useI18n: () => i18nStub() },
})

const optionValues = (app: Mounted, select: FakeNode): string[] =>
  app.find('option', select).map((option) => String(option.props.value))

describe('BackendPicker (US-005 AC9-AC10)', () => {
  test('AC9: with models [m1] renders an effort select whose options are default, low, medium, high and xhigh', () => {
    const app = mountPicker({ models: ['m1'], model: 'm1', effort: '' })

    const selects = app.find('select')
    expect(selects.length).toBeGreaterThanOrEqual(2)

    const effort = selects.find((select) => optionValues(app, select).includes('low'))
    expect(effort).toBeDefined()
    const effortSelect = effort as FakeNode
    expect(optionValues(app, effortSelect)).toEqual(['', 'low', 'medium', 'high', 'xhigh'])

    // The leading option is the "default" entry: an empty value with a rendered label.
    const [defaultOption] = app.find('option', effortSelect).filter((option) => option.props.value === '')
    expect(defaultOption).toBeDefined()
    expect(app.textOf(defaultOption as FakeNode).length).toBeGreaterThan(0)
    app.unmount()
  })

  test('AC10: with models [] shows fleet.threads.new.noBackend', () => {
    const app = mountPicker({ models: [], model: '', effort: '' })

    expect(app.text()).toContain('fleet.threads.new.noBackend')
    app.unmount()
  })

  test('a model change emits update:model with the chosen value', () => {
    const app = mountPicker({ models: ['m1', 'm2'], model: 'm1', effort: '' })

    const model = app.find('select').find((select) => {
      const values = optionValues(app, select)
      return values.includes('m2') && !values.includes('low')
    })
    expect(model).toBeDefined()
    const modelSelect = model as FakeNode
    const onChange = modelSelect.props.onChange as (e: unknown) => void
    onChange({ target: { value: 'm2' } })

    expect(app.emitted('update:model')).toEqual([['m2']])
    app.unmount()
  })

  test('an effort change emits update:effort with the chosen value', () => {
    const app = mountPicker({ models: ['m1'], model: 'm1', effort: '' })

    const effort = app.find('select').find((select) => optionValues(app, select).includes('high'))
    expect(effort).toBeDefined()
    const effortSelect = effort as FakeNode
    const onChange = effortSelect.props.onChange as (e: unknown) => void
    onChange({ target: { value: 'high' } })

    expect(app.emitted('update:effort')).toEqual([['high']])
    app.unmount()
  })
})