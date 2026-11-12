import { describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { ApiError } from '~/composables/useApi'
import type { FleetFlowDto } from '~/lib/fleet-flows'

const flow: FleetFlowDto = {
  id: 'f1', projectId: 'p1', repoId: 'r1', threadId: null, entry: 'THREAD', createdBy: { type: 'USER', id: 'u1' },
  branch: 'main', specSha: 'sha', pinnedRunnerId: null, roles: { reviewer: 'reviewer', supervisor: 'supervisor' },
  costCapUsd: '10.0000', spentUsd: '1.0000', state: 'STOPPED', approval: null, stopReason: 'verdict_unreadable',
  stopDetail: null, endedAt: null, createdAt: '2026-01-01T00:00:00.000Z', features: [], url: '/acme/flows/f1',
}

describe('flow stop reason label', () => {
  test('AC-8 displays the translated reason in the dedicated field', async () => {
    const get = jest.fn(async () => flow)
    const getOverview = jest.fn(async () => ({ repo: null, ticketRef: null, jobs: [], truncated: false, unknownCostCount: 0 }))
    const app = mountSfc(webFile('pages', '[project]', 'flows', '[id].vue'), {
      globals: {
        useRoute: () => ({ params: { project: 'acme', id: 'f1' } }),
        useI18n: () => ({ t: (key: string) => key === 'fleet.flows.stopReason.verdict_unreadable' ? 'Verdict unreadable' : key, te: (key: string) => key === 'fleet.flows.stopReason.verdict_unreadable' }),
        useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
        useFleetFlows: () => ({ get, overview: getOverview }),
        useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }),
        useProjectPermissions: () => ({ permissions: { value: { has: () => false } } }),
      },
      alias: {
        '~/composables/useFleetFlows': { useFleetFlows: () => ({ get, overview: getOverview }) },
        '~/composables/useVisiblePolling': { useVisiblePolling: () => ({ start: jest.fn(), stop: jest.fn() }) },
        '~/composables/useApi': { ApiError },
        '~/composables/useProjectMemberNames': { useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }) },
        '~/composables/usePermissions': { useProjectPermissions: () => ({ permissions: { value: { has: () => false } } }) },
      },
      components: { PageHeader: { props: ['title'], template: '<header>{{ title }}<slot name="actions" /></header>' } },
    })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(app.find('[data-testid="flow-stop-reason"]')).toHaveLength(1)
    expect(app.text()).toContain('Verdict unreadable')
    app.unmount()
  })
})
