import { describe, test, expect, jest } from '@jest/globals'
import { defineComponent, h } from 'vue'
import { useField } from 'vee-validate'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const passthrough = defineComponent({
  setup(_props, { slots }) { return () => h('div', slots.default?.()) },
})

const FormField = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props, { slots }) {
    const { value, handleChange, handleBlur } = useField<string>(() => props.name)
    return () => slots.default?.({ componentField: {
      modelValue: value.value,
      'onUpdate:modelValue': handleChange,
      onBlur: handleBlur,
    } })
  },
})

const Input = defineComponent({
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(_props, { attrs, emit }) {
    return () => h('input', { ...attrs, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })
  },
})

describe('CreateUserDialog', () => {
  test('submits ADMIN after the native role select changes to ADMIN', async () => {
    const createUser = jest.fn(async () => undefined)
    const mounted = mountSfc(webFile('components', 'CreateUserDialog.vue'), {
      props: { open: true },
      globals: {
        useI18n: () => ({ t: (key: string) => key }),
        useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
        useAdminUsers: () => ({ createUser }),
      },
      components: {
        FormField, FormItem: passthrough, FormControl: passthrough, FormLabel: passthrough,
        FormMessage: passthrough, Input, Dialog: passthrough, DialogContent: passthrough,
        DialogHeader: passthrough, DialogTitle: passthrough, Button: passthrough,
      },
      fleetComponents: ['FleetNativeSelect'],
    })

    const inputs = mounted.find('input')
    ;(inputs[0].props.onInput as (event: Event) => void)({ target: { value: 'admin@example.com' } } as unknown as Event)
    ;(inputs[1].props.onInput as (event: Event) => void)({ target: { value: 'Admin User' } } as unknown as Event)
    ;(inputs[2].props.onInput as (event: Event) => void)({ target: { value: 'StrongPass1!' } } as unknown as Event)

    const select = mounted.one('select')
    if (!select) throw new Error('Role select was not rendered')
    expect(select.props.onChange).toEqual(expect.any(Function))
    ;(select.props.onChange as (event: Event) => void)({ target: { value: 'ADMIN' } } as unknown as Event)
    const form = mounted.one('form')
    if (!form) throw new Error('User form was not rendered')
    await (form.props.onSubmit as (event: Event) => Promise<void>)({ preventDefault: jest.fn() } as unknown as Event)

    expect(createUser).toHaveBeenCalledWith({
      email: 'admin@example.com', name: 'Admin User', password: 'StrongPass1!', role: 'ADMIN',
    })
    mounted.unmount()
  })
})
