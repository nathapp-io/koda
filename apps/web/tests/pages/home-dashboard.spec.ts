import { describe, test, expect, jest } from '@jest/globals'
import * as Vue from 'vue'
import { ref, computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { HomeSnapshot } from '../../lib/home-types'

const indexPage = webFile('pages', 'index.vue')

/** Minimal Nuxt useAsyncData: resolves data/pending/error from the fetch result, with a working refresh. */
function useAsyncDataStub<T>(run: () => Promise<T>) {
  const data = ref<T | null>(null)
  const pending = ref(true)
  const error = ref<unknown>(null)
  const load = (result: Promise<T>) => {
    pending.value = true
    error.value = null
    result.then(
      (value) => { data.value = value; pending.value = false },
      (err) => { error.value = err; pending.value = false },
    )
  }
  load(run())
  return { data, pending, error, refresh: () => load(run()) }
}

/** Captures the props the page hands each home section; the sections themselves have component tests. */
function sectionStub(tag: string, prop: string, seen: Array<Record<string, unknown>>) {
  return {
    name: `Stub${tag}`,
    props: [prop, 'now'],
    setup(props: Record<string, unknown>) {
      seen.push({ stub: tag, ...props })
      return () => Vue.h('x-stub-stub', { 'data-stub': tag })
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    await Vue.nextTick()
  }
}

const snapshot: HomeSnapshot = {
  generatedAt: '2026-10-06T12:00:00Z',
  needsYou: {
    tickets: [], ticketsTotal: 2,
    approvals: [], approvalsTotal: 1,
    jobs: [], jobsTotal: 0,
  },
  projects: [{
    id: 'p1', name: 'Acme', key: 'ACME', slug: 'acme', description: null, openTickets: 2, attentionJobs: 1,
  }],
  activity: [],
}

function mountPage(getResult: Promise<HomeSnapshot>) {
  const seen: Array<Record<string, unknown>> = []
  const get = jest.fn(async () => getResult)
  const app = mountSfc(indexPage, {
    components: {
      ...uiStubs,
      HomeNeedsYou: sectionStub('home-needs-you', 'needsYou', seen),
      HomeProjectList: sectionStub('home-projects', 'projects', seen),
      HomeActivityList: sectionStub('home-activity', 'activity', seen),
    },
    globals: {
      ref, computed,
      onMounted: Vue.onMounted,
      onBeforeUnmount: Vue.onBeforeUnmount,
      definePageMeta: () => undefined,
      useI18n: () => enI18n(),
      useApi: () => ({ $api: { get } }),
      useAsyncData: (_key: string, run: () => Promise<HomeSnapshot>) => useAsyncDataStub(run),
    },
  })
  return { app, seen, get }
}

describe('home dashboard page', () => {
  test('fetches GET /home once and hands each section its slice', async () => {
    const { app, seen, get } = mountPage(Promise.resolve(snapshot))
    await settle()
    expect(get).toHaveBeenCalledWith('/home')
    const byStub = new Map(seen.map((s) => [s.stub, s]))
    expect(byStub.get('home-needs-you')?.needsYou).toEqual(snapshot.needsYou)
    expect(byStub.get('home-projects')?.projects).toEqual(snapshot.projects)
    expect(byStub.get('home-activity')?.activity).toEqual(snapshot.activity)
    expect(byStub.get('home-needs-you')?.now).toBeInstanceOf(Date)
    const buttons = app.find('[data-stub="button"]')
    expect(buttons.some((b) => app.textOf(b).includes('New Project'))).toBe(true)
    app.unmount()
  })

  test('a new workspace collapses to one primary Create project action', async () => {
    const { app } = mountPage(Promise.resolve({ ...snapshot, projects: [] }))
    await settle()
    expect(app.one('[data-stub="empty-state"]')).toBeDefined()
    expect(app.find('[data-stub="home-needs-you"]')).toEqual([])
    expect(app.one('[data-stub="empty-state"]')?.props.message).toBe('Create your first project to get started')
    app.unmount()
  })

  test('pending renders the loading state and an error renders retry', async () => {
    const { app: loadingApp } = mountPage(new Promise<HomeSnapshot>(() => undefined))
    await settle()
    expect(loadingApp.one('[data-stub="loading-state"]')).toBeDefined()
    loadingApp.unmount()

    const seen: Array<Record<string, unknown>> = []
    const get = jest.fn(async () => Promise.reject(new Error('boom')))
    const app = mountSfc(indexPage, {
      components: {
        ...uiStubs,
        HomeNeedsYou: sectionStub('home-needs-you', 'needsYou', seen),
        HomeProjectList: sectionStub('home-projects', 'projects', seen),
        HomeActivityList: sectionStub('home-activity', 'activity', seen),
      },
      globals: {
        ref, computed,
        onMounted: Vue.onMounted,
        onBeforeUnmount: Vue.onBeforeUnmount,
        definePageMeta: () => undefined,
        useI18n: () => enI18n(),
        useApi: () => ({ $api: { get } }),
        useAsyncData: (_key: string, run: () => Promise<HomeSnapshot>) => useAsyncDataStub(run),
      },
    })
    await settle()
    expect(app.one('[data-stub="error-state"]')).toBeDefined()
    app.unmount()
  })
})
