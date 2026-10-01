import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('Fleet admin Runners page wiring', () => {
  // The page lands in Task 6; until then the missing file must fail these tests
  // individually, not abort suite collection (the dialogs block below must still run).
  let page: string
  try {
    page = read('pages', 'admin', 'fleet', 'runners.vue')
  } catch {
    page = ''
  }

  test('loads through useFleetRunners and handles the admin-only 403 as ret 40003', () => {
    expect(page).toContain('useFleetRunners()')
    expect(page).toContain('err.code === 40003')
    expect(page).toContain("t('fleet.common.adminOnly')")
  })

  // The timing itself (interval, hidden tab, no overlap, visibility refresh) is pinned by
  // tests/composables/useVisiblePolling.spec.ts; this only checks the page uses it.
  test('polls every 15 s through useVisiblePolling, and stops on unmount and on 403', () => {
    expect(page).toContain('const POLL_MS = 15_000')
    expect(page).toContain('useVisiblePolling(refresh, POLL_MS)')
    expect(page).toContain('onBeforeUnmount(polling.stop)')
    expect(page).toMatch(/adminOnly\.value = true\s+polling\.stop\(\)/)
  })

  test('a failed poll keeps the rows and shows the stale note; only the first load toasts', () => {
    expect(page).toContain('stale.value = true')
    expect(page).toContain("t('fleet.common.stale')")
    expect(page).toContain('if (runners.value.length === 0) toast.error(extractApiError(err))')
  })

  test('shows online, disabled, labels, capacity, capability chips, last seen and boot age', () => {
    expect(page).toContain("runner.online ? t('fleet.common.online') : t('fleet.common.offline')")
    expect(page).toContain('v-if="!runner.enabled"')
    expect(page).toContain('<FleetRunnerCapabilityChips :capabilities="runner.capabilities" />')
    expect(page).toContain('<FleetAge :iso="runner.lastSeenAt" :now="now" mode="ago" />')
    // Uptime only means something while the runner is online (review 4b).
    expect(page).toContain('<FleetAge v-if="runner.online" :iso="runner.bootedAt" :now="now" mode="duration" />')
  })

  test('enable/disable patches, edit opens the dialog, delete asks first', () => {
    expect(page).toContain('update(runner.id, { enabled })')
    expect(page).toContain('<FleetRunnerEditDialog')
    expect(page).toContain("window.confirm(t('fleet.runners.deleteConfirm', { name: runner.name }))")
    expect(page).toContain('<FleetEnrollmentTokenDialog v-model:open="enrollOpen" />')
    // The edit dialog has its own composable instance: the page applies the saved row through its own.
    expect(page).toContain('@saved="apply"')
  })

  test('tells the admin when the list was capped', () => {
    expect(page).toContain("v-if=\"hasMore\"")
    expect(page).toContain("t('fleet.common.more', { n: FLEET_LIST_SIZE })")
  })
})

describe('Fleet runner dialogs wiring', () => {
  test('enrollment dialog posts labels, shows the token once, and forgets it on close', () => {
    const dialog = read('components', 'fleet', 'EnrollmentTokenDialog.vue')
    expect(dialog).toContain('createEnrollment(parsed.labels)')
    expect(dialog).toContain('enrollCommand(window.location.origin, created.value.token)')
    expect(dialog).toContain('navigator.clipboard.writeText(text)')
    expect(dialog).toMatch(/if \(!value\) \{\s+generation \+= 1\s+created\.value = null/)
    expect(dialog).toContain('parseLabels(value)')
  })

  test('enrollment dialog keeps a showing token safe: no silent copy failure, no accidental close, no stale reply', () => {
    const dialog = read('components', 'fleet', 'EnrollmentTokenDialog.vue')
    expect(dialog).toContain("toast.error(t('fleet.common.copyFailed'))")
    expect(dialog).toContain('@interact-outside="guardClose"')
    expect(dialog).toContain('@escape-key-down="guardClose"')
    expect(dialog).toContain('if (created.value) event.preventDefault()')
    expect(dialog).toContain('if (started !== generation) return')
    expect(dialog).toContain('@focus="selectAll"')
  })

  test('capability chips translate the credential kind code, raw when unknown', () => {
    const chips = read('components', 'fleet', 'RunnerCapabilityChips.vue')
    expect(chips).toContain('te(key) ? t(key) : kind')
  })

  test('edit dialog validates labels and capacity, patches both, and reloads its values per runner', () => {
    const dialog = read('components', 'fleet', 'RunnerEditDialog.vue')
    expect(dialog).toContain('update(props.runner.id, { labels: parsed.labels, capacity: values.capacity })')
    expect(dialog).toContain('.min(CAPACITY_MIN')
    expect(dialog).toContain('.max(CAPACITY_MAX')
    expect(dialog).toContain('resetForm({ values: initialValues() })')
    expect(dialog).toContain("emit('saved', saved)")
  })
})
