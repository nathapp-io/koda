import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const layout = readFileSync(join(__dirname, '../..', 'layouts', 'default.vue'), 'utf-8')
const template = layout.slice(layout.indexOf('<template>'))
const projectLinks = template.slice(template.indexOf('<template v-if="projectSlug">'), template.indexOf('</template>', template.indexOf('<template v-if="projectSlug">')))

describe('fleet jobs navigation', () => {
  test('a project link to /:project/fleet with the Rocket icon and nav.fleetJobs, for every member', () => {
    expect(projectLinks).toContain(':to="`/${projectSlug}/fleet`"')
    expect(projectLinks).toMatch(/<Rocket class="h-4 w-4 shrink-0" \/>\s*\{\{ t\('nav\.fleetJobs'\) \}\}/)
    expect(layout).toMatch(/import \{[^}]*\bRocket\b[^}]*\} from 'lucide-vue-next'/)
  })

  test('breadcrumbs cover the jobs list, dispatch and a job', () => {
    expect(layout).toContain('if (path === `/${project}/fleet`) {')
    expect(layout).toContain('if (path.startsWith(`/${project}/fleet/`)) {')
    expect(layout).toContain("t('fleet.jobs.dispatch')")
    expect(layout).toContain("t('fleet.jobs.detail.title')")
    expect(layout).toContain("t('fleet.budgets.title')")
  })

  test('breadcrumbs cover the schedules list and a schedule, under Fleet jobs (3b D216)', () => {
    expect(layout).toContain('if (path === `/${project}/fleet/schedules`) {')
    expect(layout).toContain('if (path.startsWith(`/${project}/fleet/schedules/`)) {')
    expect(layout).toContain("t('fleet.schedules.title')")
    expect(layout).toContain("t('fleet.schedules.detailTitle')")
    // The schedule branches must come before the generic /fleet/ branch.
    expect(layout.indexOf('/fleet/schedules/`)')).toBeLessThan(layout.indexOf('if (path.startsWith(`/${project}/fleet/`)) {'))
  })

  test('the approvals inbox has its own breadcrumb leaf (S1.5 1b D239)', () => {
    expect(layout).toContain('if (path === `/${project}/fleet/approvals`) return t(\'fleet.approvals.title\')')
  })

  test('a project link to /:project/fleet/analytics with BarChart3 for every member, and its breadcrumb leaf (S2b D399)', () => {
    expect(projectLinks).toContain(':to="`/${projectSlug}/fleet/analytics`"')
    expect(projectLinks).toMatch(/<BarChart3 class="h-4 w-4 shrink-0" \/>\s*\{\{ t\('nav\.fleetAnalytics'\) \}\}/)
    expect(layout).toContain("if (path === `/${project}/fleet/analytics`) return t('fleet.analytics.title')")
  })
})
