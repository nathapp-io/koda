import { expect, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { formatDate } from '../../lib/format-date-time'

const iso = '2026-11-10T14:07:45.657Z'
const i18n = () => ({ ...enI18n(), locale: ref('en') })
const ticket = {
  id: 'ticket-1', ref: 'WEB-1', title: 'A ticket', type: 'BUG', priority: 'MEDIUM',
  status: 'CREATED', createdAt: iso,
}

test('TicketHeader date is mount-gated', async () => {
  const app = mountSfc(webFile('components', 'TicketHeader.vue'), {
    props: { ticket, editing: false, editTitle: ticket.title, editPriority: 'MEDIUM' },
    components: uiStubs,
    globals: { useI18n: i18n },
  })
  expect(app.text()).not.toContain(formatDate(iso, 'en'))
  await nextTick()
  expect(app.text()).toContain(formatDate(iso, 'en'))
  app.unmount()
})

test('TicketProperties date is mount-gated', async () => {
  const app = mountSfc(webFile('components', 'TicketProperties.vue'), {
    props: {
      ticket: { ...ticket, labels: [], links: [] }, projectSlug: 'web', ticketRef: 'WEB-1',
      ticketLinks: [], allLabels: [], canAssign: false, canLabel: false, canUnlabel: false,
      canLink: false, canDelete: false,
    },
    components: uiStubs,
    globals: {
      useI18n: i18n,
      useApi: () => ({ $api: {} }),
      useAppToast: () => ({ success: () => undefined, error: () => undefined }),
    },
    alias: {
      '~/components/TicketActionPanel.vue': { default: { render: () => null } },
      '~/components/AssigneePicker.vue': { default: { render: () => null } },
    },
  })
  expect(app.text()).not.toContain(formatDate(iso, 'en'))
  await nextTick()
  expect(app.text()).toContain(formatDate(iso, 'en'))
  app.unmount()
})
