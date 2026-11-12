import { describe, expect, test, jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import type { FleetFlowDto, FleetFlowOverviewDto } from '~/lib/fleet-flows'

type LocaleValue = string | { [key: string]: LocaleValue }
const en = JSON.parse(readFileSync(join(__dirname, '../../i18n/locales/en.json'), 'utf8')) as LocaleValue
const zh = JSON.parse(readFileSync(join(__dirname, '../../i18n/locales/zh.json'), 'utf8')) as LocaleValue
const localeValue = (key: string): LocaleValue | undefined => key.split('.').reduce<LocaleValue | undefined>((value, part) => typeof value === 'object' ? value[part] : undefined, en)
const translate = (key: string): string => {
  const value = localeValue(key)
  return typeof value === 'string' ? value : key
}
const hasTranslation = (key: string): boolean => typeof localeValue(key) === 'string'
const flow = (overrides: Partial<FleetFlowDto> = {}): FleetFlowDto => ({
  id: 'flow-id', projectId: 'p', repoId: 'r', threadId: null, entry: 'THREAD', createdBy: { type: 'USER', id: 'u' }, branch: 'b', specSha: 'sha', pinnedRunnerId: null,
  roles: { reviewer: 'reviewer', supervisor: 'supervisor' }, costCapUsd: '1', spentUsd: '0', state: 'COMPLETED', approval: null, stopReason: null, stopDetail: null, endedAt: null,
  createdAt: '2026-01-02T03:04:05.000Z', features: [], url: '/', ...overrides,
})
const overview = (jobs: FleetFlowOverviewDto['jobs'] = []): FleetFlowOverviewDto => ({ repo: null, ticketRef: null, jobs, truncated: false, unknownCostCount: 0 })
const mountPage = async (current: FleetFlowDto, overviewValue = overview()) => {
  const header = jest.fn()
  const mounted = mountSfc(webFile('pages', '[project]', 'flows', '[id].vue'), {
    globals: {
      useRoute: () => ({ params: { project: 'acme', id: current.id } }),
      useI18n: () => ({ t: (key: string) => translate(key), te: hasTranslation }),
      useAppToast: () => ({ success: jest.fn(), error: jest.fn() }),
      useFleetFlows: () => ({ get: async () => current, overview: async () => overviewValue }),
      useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }),
      useProjectPermissions: () => ({ permissions: { value: { has: () => false } } }),
    },
    alias: {
      '~/composables/useFleetFlows': { useFleetFlows: () => ({ get: async () => current, overview: async () => overviewValue }) },
      '~/composables/useVisiblePolling': { useVisiblePolling: () => ({ start: jest.fn(), stop: jest.fn() }) },
      '~/composables/useProjectMemberNames': { useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }) },
      '~/composables/usePermissions': { useProjectPermissions: () => ({ permissions: { value: { has: () => false } } }) },
    },
    components: { LoadingState: { template: '<div>Loading</div>' }, PageHeader: { props: ['title', 'subtitle'], setup(props: { title: string; subtitle: string }) { header(props); return () => null } }, FlowFeatureSection: { template: '<div />' }, NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
  })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return { mounted, header }
}

const valueAt = (locale: LocaleValue, key: string): string | undefined => {
  const value = key.split('.').reduce<LocaleValue | undefined>((current, part) => typeof current === 'object' ? current[part] : undefined, locale)
  return typeof value === 'string' ? value : undefined
}

describe('flow detail readable labels', () => {
  test('AC-13 has a non-empty flow ID label in both locales', () => {
    expect(valueAt(en, 'fleet.flows.detail.id')?.trim()).toBeTruthy()
    expect(valueAt(zh, 'fleet.flows.detail.id')?.trim()).toBeTruthy()
  })
  test('uses feature names as title, removes id from subtitle, and displays id/date details', async () => {
    const { mounted, header } = await mountPage(flow({ features: [{ feature: 'f17-min3', specPath: '', branch: null, dependsOn: [], state: 'COMPLETED', currentStep: null, prNumber: null, questionsJobId: null, questions: null, answers: null, answeredAt: null }] }))
    expect(header.mock.calls[0]?.[0]).toMatchObject({ title: 'f17-min3', subtitle: expect.not.stringContaining('flow-id') })
    expect(mounted.text()).toContain(translate('fleet.flows.detail.id'))
    expect(mounted.text()).toContain('flow-id')
    expect(mounted.text()).toContain(new Date('2026-01-02T03:04:05.000Z').toLocaleString())
    mounted.unmount()
  })
  test('uses fallback title when there are no features and formats recorded date', async () => {
    const { mounted, header } = await mountPage(flow({ approval: { mode: 'REQUEST', approverId: null, approvedAt: '2026-01-02T03:04:05.000Z', approvalRequestId: null } }))
    expect(header.mock.calls[0]?.[0]).toMatchObject({ title: translate('fleet.flows.detail.title') })
    expect(mounted.text()).toContain(new Date('2026-01-02T03:04:05.000Z').toLocaleString())
    mounted.unmount()
  })
  test('labels flow jobs with localized command and state and preserves unknown command', async () => {
    const jobs = [
      { id: 'j1', feature: null, step: null, command: 'AGENT', state: 'COMPLETED', costUsd: '0', queuedAt: '', finishedAt: null },
      { id: 'j2', feature: null, step: null, command: 'FOO_COMMAND', state: 'COMPLETED', costUsd: '0', queuedAt: '', finishedAt: null },
    ]
    const { mounted } = await mountPage(flow(), overview(jobs))
    expect(mounted.text()).toContain(translate('fleet.command.AGENT'))
    expect(mounted.text()).toContain(translate('fleet.state.COMPLETED'))
    expect(mounted.text()).toContain('FOO_COMMAND')
    mounted.unmount()
  })
})
