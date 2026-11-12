import { describe, expect, test, jest } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const entry = {
  id: 'audit-1', key: 'project.update', resourceType: 'Project', resourceId: 'p1', projectId: 'p1',
  actor: { type: 'USER', id: 'u1' }, onBehalfOf: null, origin: 'rest',
  approval: { requiredMode: 'NONE', satisfiedBy: 'NONE', approverType: null, approverId: null, requestId: null },
  correlationId: 'c1', summary: 'Updated project', display: { actor: 'Ada', onBehalfOf: null, approver: null, project: { slug: 'koda-dogfood', name: 'Koda Dogfood' } },
  createdAt: '2026-11-12T10:00:00.000Z',
}

describe('admin audit project cell', () => {
  test('renders a nowrap project cell and keeps its project-filter button label', () => {
    const mounted = mountSfc(webFile('pages', 'admin', 'audit.vue'), {
      globals: {
        computed, ref,
        definePageMeta: () => undefined,
        useRoute: () => ({ query: {} }),
        useRouter: () => ({ replace: jest.fn() }),
        useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
        useAppToast: () => ({ error: jest.fn() }),
        useAuditLog: () => ({ entries: ref([entry]), keys: ref([]), hasNext: ref(false), pending: ref(false), load: jest.fn(), loadKeys: jest.fn() }),
      },
      alias: {
        '~/composables/useAuditLog': { useAuditLog: () => ({ entries: ref([entry]), keys: ref([]), hasNext: ref(false), pending: ref(false), load: jest.fn(), loadKeys: jest.fn() }) },
        '~/composables/useApi': { ApiError: class extends Error { code = 403 }, extractApiError: String },
        '~/components/audit/AuditEntryDetail.vue': { default: { template: '<div />' }, __esModule: true },
      },
      components: {
        PageHeader: { template: '<header />' }, FilterBar: { template: '<div><slot /></div>' },
        FleetNativeSelect: { template: '<select />' }, Input: { template: '<input />' }, Button: { template: '<button><slot /></button>' },
        LoadingState: { template: '<div />' }, Table: { template: '<table><slot /></table>' },
        TableHeader: { template: '<thead><slot /></thead>' }, TableBody: { template: '<tbody><slot /></tbody>' },
        TableRow: { template: '<tr><slot /></tr>' }, TableHead: { template: '<th><slot /></th>' },
        TableCell: { template: '<td><slot /></td>' }, Badge: { template: '<span><slot /></span>' },
      },
    })
    const cell = mounted.one('[data-testid="audit-project-cell"]')
    expect(cell?.props.class).toBe('whitespace-nowrap')
    const button = mounted.one('[data-testid="audit-project"]', cell)
    expect(button).toBeDefined()
    expect(button ? mounted.textOf(button) : null).toBe('koda-dogfood')
    mounted.unmount()
  })
})
