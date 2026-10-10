import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const switchFile = webFile('components', 'ui', 'switch', 'Switch.vue')

/**
 * Stands in for radix-vue's SwitchRoot. Radix renders DOM nodes and calls DOM-only APIs that the
 * node harness does not provide, so this double records exactly what the wrapper forwards to it:
 * the `checked` and `disabled` props, and the `update:checked` listener. It renders its default
 * slot so the wrapper's SwitchThumb child is part of the tree, as it is in production.
 */
const recordedRoot: { props: Record<string, unknown>; emit: ((event: 'update:checked', value: boolean) => void) | null } = { props: {}, emit: null }

const radixStub = {
  SwitchRoot: {
    name: 'RadixSwitchRoot',
    props: ['checked', 'disabled', 'id', 'name'],
    emits: ['update:checked'],
    setup(props: Record<string, unknown>, { slots, emit }: { slots: Record<string, (() => unknown) | undefined>; emit: (event: 'update:checked', value: boolean) => void }) {
      recordedRoot.props = { ...props }
      recordedRoot.emit = emit
      return () => Vue.h('x-stub-stub', { 'data-stub': 'switch-root', 'data-checked': String(props.checked), 'data-disabled': String(props.disabled) }, slots.default?.() as never)
    },
  },
  SwitchThumb: {
    name: 'RadixSwitchThumb',
    setup: () => () => Vue.h('x-stub-stub', { 'data-stub': 'switch-thumb' }),
  },
}

function mountSwitch(props: Record<string, unknown>) {
  return mountSfc(switchFile, {
    props,
    alias: { 'radix-vue': radixStub },
    globals: {},
  })
}

describe('components/ui/switch Switch (US-007)', () => {
  test('forwards checked to SwitchRoot', () => {
    const app = mountSwitch({ checked: true })

    expect(recordedRoot.props.checked).toBe(true)
    app.unmount()
  })

  test('forwards disabled to SwitchRoot so a locked switch stays locked', () => {
    const app = mountSwitch({ checked: false, disabled: true })

    expect(recordedRoot.props.disabled).toBe(true)
    app.unmount()
  })

  test('renders its thumb inside the root', () => {
    const app = mountSwitch({ checked: false })

    expect(app.find('[data-stub="switch-thumb"]')).toHaveLength(1)
    app.unmount()
  })

  test('re-emits the root update:checked event with the new value', () => {
    const app = mountSwitch({ checked: false })

    recordedRoot.emit?.('update:checked', true)

    expect(app.emitted('update:checked')).toEqual([[true]])
    app.unmount()
  })

  test('a flip to false is re-emitted as false, not dropped', () => {
    const app = mountSwitch({ checked: true })

    recordedRoot.emit?.('update:checked', false)

    expect(app.emitted('update:checked')).toEqual([[false]])
    app.unmount()
  })
})
