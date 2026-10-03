import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'

const projectPage = webFile('pages', '[project]', 'fleet', 'approvals.vue')
const adminPage = webFile('pages', 'admin', 'fleet', 'approvals.vue')

/** Captures the props the page hands the inbox. Declared props are camelCased by Vue; listeners stay in attrs. */
function inboxStub(seen: Array<Record<string, unknown>>) {
  return {
    name: 'StubFleetApprovalInbox',
    inheritAttrs: false,
    props: ['base', 'viewer', 'scopeLabel', 'nameOf', 'jobLink', 'projectName'],
    setup(props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
      seen.push({ ...props, ...attrs })
      return () => Vue.h('x-stub-stub', { 'data-stub': 'approval-inbox' })
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

describe('project approvals page', () => {
  test('hands the inbox the project base, the viewer\'s rights and member names', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountSfc(projectPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda' } }),
        useI18n: () => enI18n(),
        useProjectViewerRole: () => ({ data: ref({ canManage: true, viewerRole: 'ADMIN' }) }),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: (id: string) => (id === 'u1' ? 'Ada' : null) }),
        useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => `repo-${id}` }),
      },
    })
    await settle()
    const props = seen[0]
    expect(props.base).toEqual({ kind: 'project', slug: 'koda' })
    expect(props.viewer).toEqual({ kind: 'project', canManage: true })
    expect((props.nameOf as (id: string) => string | null)('u1')).toBe('Ada')
    expect((props.jobLink as (p: string, j: string) => string | null)('p1', 'j1')).toBe('/koda/fleet/jobs/j1')
    const scopeLabel = props.scopeLabel as (p: { scopeType: string; scopeId: string | null }) => string | null
    expect(scopeLabel({ scopeType: 'project', scopeId: 'p1' })).toBe('koda')
    expect(scopeLabel({ scopeType: 'repo', scopeId: 'r1' })).toBe('repo-r1')
    expect(app.one('[data-stub="page-header"]')?.props.title).toBe('Approvals')
    app.unmount()
  })
})

describe('admin approvals page', () => {
  function mountAdmin(seen: Array<Record<string, unknown>>) {
    return mountSfc(adminPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useI18n: () => enI18n(),
        useFleetRepos: () => ({ projects: ref([{ id: 'p1', slug: 'koda', name: 'Koda' }]), loadProjects: jest.fn(async () => undefined) }),
        useFleetRunners: () => ({ runners: ref([{ id: 'r1', name: 'mac-1' }]), load: jest.fn(async () => undefined) }),
        useAdminUsers: () => ({ users: ref([{ id: 'u1', email: 'ada@k.t', name: 'Ada' }]), load: jest.fn(async () => undefined) }),
      },
    })
  }

  test('names projects, runners and users from the admin lookups', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen)
    await settle()
    const props = seen[0]
    expect(props.base).toEqual({ kind: 'admin' })
    expect(props.viewer).toEqual({ kind: 'admin' })
    const projectName = props.projectName as (id: string | null) => string
    expect(projectName('p1')).toBe('koda')
    expect(projectName(null)).toBe('Fleet-wide')
    expect(projectName('gone')).toBe('gone')
    const jobLink = props.jobLink as (p: string, j: string) => string | null
    expect(jobLink('p1', 'j1')).toBe('/koda/fleet/jobs/j1')
    expect(jobLink('gone', 'j1')).toBeNull()
    expect((props.nameOf as (id: string) => string | null)('u1')).toBe('Ada')
    const scopeLabel = props.scopeLabel as (p: { scopeType: string; scopeId: string | null }) => string | null
    expect(scopeLabel({ scopeType: 'runner', scopeId: 'r1' })).toBe('mac-1')
    expect(scopeLabel({ scopeType: 'project', scopeId: 'p1' })).toBe('koda')
    app.unmount()
  })

  test('a 403 from the inbox shows the admin-only line', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen)
    await settle()
    ;(seen[0].onForbidden as () => void)()
    await settle()
    expect(app.find('[data-testid="fleet-approvals-admin-only"]')).toHaveLength(1)
    app.unmount()
  })
})
