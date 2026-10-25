/**
 * US-007 — `components/audit/AuditEntryDetail.vue`: the provenance and approval block an audit row
 * expands into. Mounted for real, so every assertion is about the markup the component produces for
 * one `AuditEntryDto` and the event it emits back to the page.
 */
import { describe, expect, test } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { AuditEntry } from '~/composables/useAuditLog'
import enJson from '../../i18n/locales/en.json'
import zhJson from '../../i18n/locales/zh.json'

const detail = webFile('components', 'audit', 'AuditEntryDetail.vue')

/** One entry as `GET /audit` returns it, with no approval and no on-behalf-of principal. */
const ENTRY: AuditEntry = {
  id: 'e1',
  key: 'ticket.create',
  resourceType: 'ticket',
  resourceId: 't1',
  projectId: 'p1',
  actor: { type: 'USER', id: 'u1' },
  onBehalfOf: null,
  origin: 'rest',
  approval: { requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null },
  correlationId: 'c-1',
  summary: 'created',
  display: { actor: 'Ada', onBehalfOf: null, approver: null, project: { slug: 'web', name: 'Web' } },
  createdAt: '2026-10-01T10:00:00.000Z',
}

function mount(over: Partial<AuditEntry> = {}) {
  const entry: AuditEntry = { ...ENTRY, ...over }
  const app = mountSfc(detail, {
    components: uiStubs,
    props: { entry },
    globals: { computed, useI18n: () => enI18n() },
  })
  /** The element carrying `data-testid`, e.g. the detail block itself or the show-related button. */
  const byId = (id: string) => app.find(`[data-testid="${id}"]`)
  /** The wrapper of one labelled field (`data-field`), so labels cannot be confused for each other. */
  const field = (name: string) => app.find(`[data-field="${name}"]`)
  const fieldText = (name: string): string => {
    const found = field(name)[0]
    if (!found) throw new Error(`no ${name} field in: ${app.text()}`)
    return app.textOf(found)
  }
  return { app, entry, byId, field, fieldText }
}

describe('AuditEntryDetail (Permissions P2 US-007)', () => {
  test('AC-2: an mcp write approved by a human shows the origin, the satisfied-by, the approver and the request id', () => {
    const m = mount({
      origin: 'mcp',
      approval: { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' },
      display: { ...ENTRY.display, approver: 'Bea' },
    })

    expect(m.fieldText('origin')).toContain('MCP')
    expect(m.fieldText('satisfiedBy')).toContain('Human')
    expect(m.fieldText('approver')).toContain('Bea')
    expect(m.fieldText('requestId')).toContain('pa1')
    m.app.unmount()
  })

  test('B1: clicking the approver emits its id', () => {
    const m = mount({
      approval: { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' },
      display: { ...ENTRY.display, approver: 'Bea' },
    })
    const button = m.app.find('[data-testid="audit-approver"]')[0]
    expect(m.app.textOf(button)).toContain('Bea')
    button.props.onClick()
    expect(m.app.emitted('approver')).toEqual([['u2']])
    m.app.unmount()
  })

  test('AC-3: no approval shows neither an approver nor a request id, even when the API sends one', () => {
    const m = mount({
      approval: { requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: 'pa9' },
    })

    expect(m.field('approver')).toHaveLength(0)
    expect(m.field('requestId')).toHaveLength(0)
    // The block itself is still there: the origin, the correlation id and the time are provenance.
    expect(m.byId('audit-detail')).toHaveLength(1)
    expect(m.fieldText('origin')).toContain('REST')
    m.app.unmount()
  })

  test('AC-4: the required approval mode is labelled', () => {
    const m = mount({
      approval: { requiredMode: 'human', satisfiedBy: 'self', approverType: 'USER', approverId: 'u1', requestId: null },
    })

    expect(m.fieldText('requiredMode')).toContain('Human')
    expect(m.fieldText('satisfiedBy')).toContain('Self')
    m.app.unmount()
  })

  test('AC-5: an on-behalf-of principal and the full ISO timestamp are shown', () => {
    const m = mount({
      onBehalfOf: { type: 'USER', id: 'u2' },
      display: { ...ENTRY.display, onBehalfOf: 'Bea' },
      createdAt: '2026-10-25T09:19:52.501Z',
    })

    expect(m.fieldText('onBehalfOf')).toContain('Bea')
    expect(m.fieldText('createdAt')).toContain('2026-10-25T09:19:52.501Z')
    m.app.unmount()
  })

  test('AC-6: Show related emits the entry correlation id', () => {
    const m = mount({ correlationId: 'c-1' })

    expect(m.byId('audit-show-related')).toHaveLength(1)
    m.byId('audit-show-related')[0].props.onClick()
    expect(m.app.emitted('related')).toEqual([['c-1']])
    m.app.unmount()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Edges the ACs imply
  // ───────────────────────────────────────────────────────────────────────────

  test('a principal the API could not name falls back to its raw id', () => {
    const m = mount({
      approval: { requiredMode: 'human', satisfiedBy: 'human', approverType: 'AGENT', approverId: 'a9', requestId: 'pa2' },
      display: { ...ENTRY.display, approver: null },
    })

    expect(m.fieldText('approver')).toContain('a9')
    m.app.unmount()
  })

  test('an unresolved on-behalf-of principal falls back to its raw id', () => {
    const m = mount({ onBehalfOf: { type: 'USER', id: 'ghost' } })

    expect(m.fieldText('onBehalfOf')).toContain('ghost')
    m.app.unmount()
  })

  test('with no on-behalf-of principal the field is omitted', () => {
    const m = mount()

    expect(m.field('onBehalfOf')).toHaveLength(0)
    m.app.unmount()
  })

  test('the correlation id itself is always shown next to its button', () => {
    const m = mount({ correlationId: 'corr-42' })

    expect(m.fieldText('correlationId')).toContain('corr-42')
    m.app.unmount()
  })

  test('the already-satisfied modes all have a label of their own', () => {
    const self = mount({ approval: { requiredMode: 'self', satisfiedBy: 'self', approverType: null, approverId: null, requestId: null } })
    expect(self.fieldText('requiredMode')).toContain('Self')
    self.app.unmount()

    const agent = mount({ approval: { requiredMode: 'agent', satisfiedBy: 'agent', approverType: 'AGENT', approverId: 'a1', requestId: null } })
    expect(agent.fieldText('satisfiedBy')).toContain('Agent')
    agent.app.unmount()

    const none = mount({ approval: { requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null } })
    expect(none.fieldText('satisfiedBy')).toContain('None')
    none.app.unmount()
  })

  test('every origin has a label, so no row can render a raw enum value', () => {
    const origins = ['rest', 'mcp', 'thread', 'runner', 'system'] as const
    for (const origin of origins) {
      const m = mount({ origin })
      const text = m.fieldText('origin')
      expect(text).not.toBe('')
      expect(text).not.toContain('admin.audit.origin')
      m.app.unmount()
    }
  })

  test('the new locale keys exist in both locales', () => {
    // `used-keys-exist` scans literal keys only; the origin and approval-mode labels are built from
    // the entry's values, so the five and four keys are pinned here for en and zh.
    const auditOf = (locale: unknown): Record<string, unknown> => (locale as { admin: { audit: Record<string, unknown> } }).admin.audit
    for (const locale of [enJson, zhJson]) {
      const copy = auditOf(locale)
      const origin = copy.origin as Record<string, string>
      const mode = copy.approvalMode as Record<string, string>
      for (const value of ['rest', 'mcp', 'thread', 'runner', 'system']) expect(origin[value]?.trim()).toBeTruthy()
      for (const value of ['none', 'self', 'agent', 'human']) expect(mode[value]?.trim()).toBeTruthy()
      expect((locale as { nav: { audit?: string } }).nav.audit?.trim()).toBeTruthy()
      const detailCopy = copy.detail as Record<string, string>
      for (const key of ['origin', 'correlationId', 'showRelated', 'requiredMode', 'satisfiedBy', 'approver', 'requestId', 'onBehalfOf', 'createdAt']) {
        expect(detailCopy[key]?.trim()).toBeTruthy()
      }
    }
  })
})
