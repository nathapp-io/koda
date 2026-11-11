import { describe, test, expect } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed, watch, nextTick } from 'vue'
import { mountSfc, webFile, loadSfc } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { FakeNode } from '../helpers/mount-sfc'

const dialog = webFile('components', 'memory', 'MemoryRetireDialog.vue')

function mountRetireDialog(over: { open?: boolean; busy?: boolean; itemLabel?: string } = {}) {
  const app = mountSfc(dialog, {
    components: {
      ...uiStubs,
      FormField: loadSfc(webFile('components', 'ui', 'form', 'FormField.vue')),
      FormMessage: loadSfc(webFile('components', 'ui', 'form', 'FormMessage.vue')),
    },
    props: { open: over.open ?? true, busy: over.busy ?? false, itemLabel: over.itemLabel ?? 'Memory item' },
    globals: {
      ref, computed, watch, nextTick,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      useI18n: () => enI18n(),
    },
  })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await Vue.nextTick()
    }
  }
  return { app, flush }
}

type Mounted = ReturnType<typeof mountRetireDialog>['app']

function typeReason(app: Mounted, value: string): void {
  const field = app.find('[data-stub="textarea"]').find((n: FakeNode) => n.props['data-testid'] === 'memory-retire-reason')
  if (!field) throw new Error('no retire reason field')
  ;(field.props['onUpdate:modelValue'] as (v: string) => void)(value)
}

function button(app: Mounted, key: string): FakeNode | undefined {
  return app.find('[data-stub="button"]').find((n) => app.textOf(n) === enI18n().t(key))
}

async function submit(app: Mounted): Promise<void> {
  await (app.one('form')?.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined })
}

describe('MemoryRetireDialog (US-002)', () => {
  test('AC-1: emits the typed retirement reason on confirm', async () => {
    const { app, flush } = mountRetireDialog({ itemLabel: '<img src=x>' })
    await flush()
    expect(app.text()).toContain('<img src=x>')
    typeReason(app, 'obsolete')
    await flush()
    await submit(app)
    expect(app.emitted('confirm')).toEqual([['obsolete']])
    app.unmount()
  })

  test('AC-2: shows the inline length validation message for 501 characters', async () => {
    const { app, flush } = mountRetireDialog()
    await flush()
    typeReason(app, 'x'.repeat(501))
    await flush()
    await submit(app)
    await flush()
    expect(app.text()).toContain(enI18n().t('memory.retire.reasonTooLong'))
    app.unmount()
  })

  test('AC-3: does not emit confirm for an invalid reason', async () => {
    const { app, flush } = mountRetireDialog()
    await flush()
    typeReason(app, 'x'.repeat(501))
    await flush()
    await submit(app)
    await flush()
    expect(app.emitted('confirm')).toHaveLength(0)
    app.unmount()
  })

  test('AC-4: disables confirm while busy', async () => {
    const { app, flush } = mountRetireDialog({ busy: true })
    await flush()
    expect(button(app, 'memory.retire.confirm')?.props.disabled).toBe(true)
    app.unmount()
  })

  test('AC-5: cancel emits update:open false', async () => {
    const { app, flush } = mountRetireDialog()
    await flush()
    ;(button(app, 'common.cancel')?.props.onClick as () => void)()
    expect(app.emitted('update:open')).toEqual([[false]])
    app.unmount()
  })

  test('AC-6: clears the draft when the dialog closes and reopens', async () => {
    const { app, flush } = mountRetireDialog()
    await flush()
    typeReason(app, 'old')
    await flush()
    app.setProps({ open: false })
    await flush()
    app.setProps({ open: true })
    await flush()
    const field = app.find('[data-stub="textarea"]').find((n: FakeNode) => n.props['data-testid'] === 'memory-retire-reason')
    expect(field?.props.modelValue).toBe('')
    app.unmount()
  })
})
