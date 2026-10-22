import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import { globalPermissionsStub, projectPermissionsStub } from '../helpers/permission-nav'

const projectPage = webFile('pages', '[project]', 'fleet', 'approvals.vue')
const adminPage = webFile('pages', 'admin', 'fleet', 'approvals.vue')

/** Captures the props the page hands the inbox. Declared props are camelCased by Vue; listeners stay in attrs. */
function inboxStub(seen: Array<Record<string, unknown>>) {
  return {
    name: 'StubFleetApprovalInbox',
    inheritAttrs: false,
    props: ['base', 'viewer', 'scopeLabel', 'nameOf', 'jobLink', 'projectName'],
    setup(props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
      // A computed viewer re-renders when the keys land, so the last render is the settled one.
      return () => {
        seen.push({ ...props, ...attrs })
        return Vue.h('x-stub-stub', { 'data-stub': 'approval-inbox' })
      }
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

const last = (seen: Array<Record<string, unknown>>): Record<string, unknown> | undefined => seen[seen.length - 1]

describe('project approvals page', () => {
  test('hands the inbox the project base, the viewer\'s keys and member names', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountSfc(projectPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda' } }),
        useI18n: () => enI18n(),
        useAuth: () => ({ user: ref({ id: 'u1' }) }),
        // Permissions P1 US-009: the decide keys, not the member role, decide what the viewer may answer.
        useProjectPermissions: () => projectPermissionsStub(['fleet.approval.decide.budget', 'fleet.approval.decide.bash']),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: (id: string) => (id === 'u1' ? 'Ada' : null) }),
        useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => `repo-${id}` }),
      },
    })
    await settle()
    const props = last(seen) ?? {}
    expect(props.base).toEqual({ kind: 'project', slug: 'koda' })
    // 2aw-D6: the viewer carries the signed-in user, because an assistant_action is decided by its requester alone.
    expect(props.viewer).toEqual({ kind: 'project', userId: 'u1', canDecideBudget: true, canDecideBash: true })
    expect((props.nameOf as (id: string) => string | null)('u1')).toBe('Ada')
    expect((props.jobLink as (p: string, j: string) => string | null)('p1', 'j1')).toBe('/koda/fleet/jobs/j1')
    const scopeLabel = props.scopeLabel as (p: { scopeType: string; scopeId: string | null }) => string | null
    expect(scopeLabel({ scopeType: 'project', scopeId: 'p1' })).toBe('koda')
    expect(scopeLabel({ scopeType: 'repo', scopeId: 'r1' })).toBe('repo-r1')
    expect(app.one('[data-stub="page-header"]')?.props.title).toBe('Approvals')
    app.unmount()
  })

  test('a signed-out visitor gets userId null (2aw-D6)', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountSfc(projectPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda' } }),
        useI18n: () => enI18n(),
        useAuth: () => ({ user: ref(null) }),
        useProjectPermissions: () => projectPermissionsStub(['fleet.approval.decide.bash']),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
        useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => id }),
      },
    })
    await settle()
    expect(last(seen)?.viewer).toEqual({ kind: 'project', userId: null, canDecideBudget: false, canDecideBash: true })
    app.unmount()
  })

  test.each([
    ['every decide key', ['fleet.approval.decide.budget', 'fleet.approval.decide.bash'], { canDecideBudget: true, canDecideBash: true }],
    ['only the bash key', ['fleet.approval.decide.bash'], { canDecideBudget: false, canDecideBash: true }],
    ['none of them', [], { canDecideBudget: false, canDecideBash: false }],
  ])('a %s gets a viewer built from that set (US-009)', async (_name, keys, expected) => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountSfc(projectPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda' } }),
        useI18n: () => enI18n(),
        useAuth: () => ({ user: ref({ id: 'u1' }) }),
        useProjectPermissions: () => projectPermissionsStub(keys),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
        useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => id }),
      },
    })
    await settle()
    expect(last(seen)?.viewer).toEqual({ kind: 'project', userId: 'u1', ...expected })
    app.unmount()
  })

  test('a pending key fetch closes both decisions', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountSfc(projectPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'koda' } }),
        useI18n: () => enI18n(),
        useAuth: () => ({ user: ref({ id: 'u1' }) }),
        useProjectPermissions: () => projectPermissionsStub(['fleet.approval.decide.budget'], { pending: true }),
        useProjectMemberNames: () => ({ load: jest.fn(async () => undefined), nameOf: () => null }),
        useFleetDispatchOptions: () => ({ load: jest.fn(async () => undefined), repoName: (id: string) => id }),
      },
    })
    await settle()
    expect(last(seen)?.viewer).toEqual({ kind: 'project', userId: 'u1', canDecideBudget: false, canDecideBash: false })
    app.unmount()
  })
})

describe('admin approvals page', () => {
  function mountAdmin(seen: Array<Record<string, unknown>>, user: unknown = { id: 'u1' }, keys: readonly string[] = []) {
    return mountSfc(adminPage, {
      components: { ...uiStubs, FleetApprovalInbox: inboxStub(seen) },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        definePageMeta: () => undefined,
        useI18n: () => enI18n(),
        useAuth: () => ({ user: ref(user) }),
        // Permissions P1 US-009: the admin inbox decides from the global set.
        useGlobalPermissions: () => globalPermissionsStub(keys),
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
    const props = last(seen) ?? {}
    expect(props.base).toEqual({ kind: 'admin' })
    // 2aw-D6: the admin viewer knows who is signed in, so an assistant_action can be the requester's.
    expect(props.viewer).toEqual({ kind: 'admin', userId: 'u1', canDecideBudget: false, canDecideBash: false })
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

  test('the global decide keys reach the viewer (US-009)', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen, { id: 'u1' }, ['fleet.approval.decide.budget'])
    await settle()
    expect(last(seen)?.viewer).toEqual({ kind: 'admin', userId: 'u1', canDecideBudget: true, canDecideBash: false })
    app.unmount()
  })

  test('a signed-out admin viewer gets userId null (2aw-D6)', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen, null)
    await settle()
    expect(last(seen)?.viewer).toEqual({ kind: 'admin', userId: null, canDecideBudget: false, canDecideBash: false })
    app.unmount()
  })

  test('a 403 from the inbox shows the admin-only line', async () => {
    const seen: Array<Record<string, unknown>> = []
    const app = mountAdmin(seen)
    await settle()
    ;(last(seen)?.onForbidden as () => void)()
    await settle()
    expect(app.find('[data-testid="fleet-approvals-admin-only"]')).toHaveLength(1)
    app.unmount()
  })
})
