import { describe, test, expect } from '@jest/globals'
import { computed, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs, enI18n } from '../helpers/fleet-harness'
import type { HomeProject } from '../../lib/home-types'

const projectList = webFile('components', 'home', 'HomeProjectList.vue')

const project = (over: Partial<HomeProject> = {}): HomeProject => ({
  id: 'p1', name: 'Acme', key: 'ACME', slug: 'acme', description: 'The main project',
  openTickets: 3, attentionJobs: 0, ...over,
})

function mount(projects: HomeProject[]) {
  return mountSfc(projectList, {
    components: uiStubs,
    props: { projects },
    globals: { ref, computed, useI18n: () => enI18n() },
  })
}

describe('HomeProjectList', () => {
  test('rows link to the project board and show key, description and open count', () => {
    const app = mount([project()])
    const row = app.one('[data-stub="nuxt-link"]')
    expect(row?.props.to).toBe('/acme')
    expect(app.text()).toContain('Acme')
    expect(app.text()).toContain('ACME')
    expect(app.text()).toContain('The main project')
    expect(app.text()).toContain('3 open')
    expect(app.one('[data-testid="home-project-acme"]')).toBeDefined()
    app.unmount()
  })

  test('an attention count shows a destructive chip; zero stays quiet', () => {
    const app = mount([project({ attentionJobs: 2 }), project({ id: 'p2', slug: 'ops', key: 'OPS', name: 'Ops' })])
    expect(app.text()).toContain('2 need attention')
    expect(app.one('[data-testid="home-project-ops"]')).toBeDefined()
    app.unmount()
  })
})
