import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const header = webFile('components', 'TicketHeader.vue')
const ticket = { id: 't1', ref: 'WEB-3', title: 'Add CSV export', type: 'ENHANCEMENT', priority: 'HIGH', status: 'CREATED', createdAt: '2026-10-07T00:00:00.000Z' }
const href = { path: '/web/fleet/dispatch', query: { command: 'PLAN', tickets: 'WEB-3', feature: 'web-3-add-csv-export' } }

function mountHeader(props: Record<string, unknown>) {
  return mountSfc(header, {
    // Editing mode renders the priority select; plain tags keep the output free of resolve warnings.
    components: { ...uiStubs, Select: 'div', SelectTrigger: 'div', SelectValue: 'span', SelectContent: 'div', SelectItem: 'div' },
    props: { ticket, editing: false, editTitle: '', editPriority: 'HIGH', ...props },
    globals: { useI18n: () => ({ ...enI18n(), locale: Vue.ref('en') }) },
  })
}

describe('TicketHeader Dispatch link (C9 §4, D461)', () => {
  test('renders the link with the given target', () => {
    const app = mountHeader({ dispatchHref: href })
    const link = app.one('[data-testid="ticket-fleet-dispatch"]')
    expect(link?.props.to).toEqual(href)
    expect(link && app.textOf(link).trim()).toBe('Dispatch')
    app.unmount()
  })

  test('hidden without a target and while editing', () => {
    for (const props of [{}, { dispatchHref: null }, { dispatchHref: href, editing: true }]) {
      const app = mountHeader(props)
      expect(app.one('[data-testid="ticket-fleet-dispatch"]')).toBeUndefined()
      app.unmount()
    }
  })
})
