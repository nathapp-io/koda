import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('Fleet admin Repos page wiring', () => {
  const page = read('pages', 'admin', 'fleet', 'repos.vue')

  test('loads through useFleetRepos, handles the admin-only 403, then labels projects and checks every row', () => {
    expect(page).toContain('useFleetRepos()')
    expect(page).toContain('err.code === 40003')
    expect(page).toMatch(/await loadRows\(\)[\s\S]*await loadProjects\(\)[\s\S]*await checkAll\(\)/)
  })

  test('each row has a reachability badge and a recheck button that is disabled while checking', () => {
    expect(page).toContain('<FleetRepoReachabilityBadge :state="checks[repo.id]" />')
    expect(page).toContain("checks[repo.id]?.status === 'checking'")
    expect(page).toContain('@click="check(repo.id)"')
  })

  test('delete asks first; a new repo reloads the rows and checks only itself', () => {
    expect(page).toContain("window.confirm(t('fleet.repos.deleteConfirm', { repo: repoName(repo) }))")
    expect(page).toContain('<FleetAddRepoDialog v-model:open="addOpen" :projects="projects" @created="onCreated" />')
    expect(page).toMatch(/async function onCreated\(repo: FleetRepo\)[\s\S]*?await check\(repo\.id\)/)
    expect(page.match(/async function onCreated[\s\S]*?\n\}/)?.[0]).not.toContain('checkAll')
  })
})

describe('Fleet repo components wiring', () => {
  test('add dialog posts through useFleetRepos().create and shows API errors via extractApiError', () => {
    const dialog = read('components', 'fleet', 'AddRepoDialog.vue')
    expect(dialog).toContain('await create(values)')
    expect(dialog).toContain('toast.error(extractApiError(err))')
    expect(dialog).toContain('REPO_OWNER_PATTERN')
    expect(dialog).toContain('REPO_NAME_PATTERN')
    // Native selects through FleetNativeSelect (plan D137, issue #58): a bare <select> cannot bind
    // componentField, so the form value would never change (FleetNativeSelect's own spec proves it binds).
    expect(dialog).toContain('<FleetNativeSelect v-bind="componentField"')
    expect(dialog).not.toMatch(/<select[^>]*v-bind="componentField"/)
    expect(dialog).toContain('testid="fleet-repo-project"')
    expect(dialog).toContain('testid="fleet-repo-provider"')
    expect(dialog).not.toContain('<SelectContent')
  })

  test('the badge translates known reasons and falls back to the raw code', () => {
    const badge = read('components', 'fleet', 'RepoReachabilityBadge.vue')
    expect(badge).toContain('te(key) ? t(key) : reason')
  })
})
