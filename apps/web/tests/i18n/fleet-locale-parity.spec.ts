import { describe, test, expect } from '@jest/globals'
import { CELL_STATES } from '~/lib/fleet-credential-board'
import { CREDENTIAL_WHY, SEVERITIES, TILE_IDS, UNPLACEABLE_VERDICTS } from '~/lib/fleet-dashboard-types'

const en = require('../../i18n/locales/en.json') as Record<string, unknown>
const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

type Tree = Record<string, unknown>

function at(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)
}

function leafPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Tree).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

// The API's enumerations (S1 spec; slice 4 overview). Each one is rendered through a
// dynamic key (fleet.state.<STATE> ...), which used-keys-exist.spec cannot see.
const ENUMS: Record<string, string[]> = {
  'fleet.state': ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'],
  'fleet.misfit': ['disabled', 'offline', 'budget_paused', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'interaction', 'tools', 'approvals_relay', 'busy_repo', 'capacity', 'config_jobs'],
  'fleet.repoReason': [
    'github_app_not_configured', 'github_app_key_unreadable', 'app_not_installed', 'app_permissions_insufficient',
    'repo_not_found', 'provider_unreachable', 'provider_error', 'vcs_connection_missing', 'vcs_connection_mismatch',
    'vcs_encryption_key_missing', 'gitlab_token_invalid', 'gitlab_access_insufficient', 'gitlab_scope_missing',
  ],
  'fleet.common.ago': ['s', 'm', 'h', 'd'],
  'fleet.common.duration': ['s', 'm', 'h', 'd'],
  'fleet.repos.provider': ['github', 'gitlab'],
  'fleet.runners.chip.kind': ['api-key', 'oauth', 'exec', 'ambient', 'none'],
  'fleet.command': ['CONFIG_DRIFT', 'CONFIG_EDIT', 'PLAN', 'RUN'],
  'fleet.config.group': ['config', 'constitution', 'context', 'profiles', 'rules'],
  'fleet.config.status': ['deleted', 'modified', 'new', 'unchanged'],
  'fleet.config.panel.mode': ['drift', 'edit', 'regenerate'],
  'fleet.config.panel.outcome': ['conflict', 'drift', 'invalid', 'no_changes', 'ok', 'pr_failed', 'push_failed', 'timeout'],
  'fleet.config.panel.files': ['conflict', 'drift', 'ok'],
  'fleet.config.problem': ['conflict', 'file_too_large', 'json', 'too_many', 'total_too_large'],
  'fleet.budgets.scope': ['global', 'project', 'repo', 'runner'],
  'fleet.budgets.scopeText': ['global', 'project', 'repo', 'runner'],
  'fleet.budgets.window': ['calendar_month_utc', 'lifetime'],
  'fleet.budgets.status': ['paused', 'warning', 'ok'],
  'fleet.budgets.runningJobs': ['finish', 'cancel'],
  'fleet.budgets.hardStop': ['on', 'off'],
  'fleet.budgets.banner': ['paused', 'warning', 'more', 'view', 'review'],
  'fleet.schedules.status': ['enabled', 'completed', 'finish_failed', 'no_progress', 'owner_lost_access', 'template_invalid', 'manual'],
  'fleet.schedules.form.placementMode': ['auto', 'labels', 'pin'],
  'fleet.approvals.type': ['budget_override_required', 'nax_bash_escalate'],
  'fleet.logs.streams': ['run', 'stdout', 'stderr'],
  'fleet.logs.notice': ['bundle', 'truncated', 'incomplete', 'expired', 'legacy'],
  'fleet.approvals.status': ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
  'fleet.approvals.decision': ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'],
  'fleet.approvals.resolvedBy': ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'],
  'fleet.approvals.requeueFailure': ['gone', 'activeJob', 'notCancelled', 'paused', 'unknown'],
  'fleet.approvals.tabs': ['pending', 'all'],
  'fleet.approvals.empty': ['pending', 'all'],
  'fleet.approvals.validation': ['amountInvalid', 'notAbove', 'commentTooLong'],
  'fleet.approvals.bash.action': ['allow', 'allow_for_job', 'deny'],
  'fleet.approvals.toast': ['raise_budget_and_resume', 'keep_paused', 'requeueFailed', 'allow', 'allow_for_job', 'deny'],
  'fleet.approvals.delivery': ['delivered', 'failed', 'waiting'],
  'fleet.bash.mode': ['raw', 'gated', 'escalate'],
  'fleet.analytics.groupBy': ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story', 'project'],
  'fleet.analytics.outcome': ['opened', 'promoted', 'escalated', 'skipped', 'other'],
  'fleet.analytics.ingestStatus': ['pending', 'running', 'done', 'partial', 'failed'],
  'fleet.dashboard.severity': ['error', 'warning'],
  'fleet.dashboard.tiles': ['runners', 'queued', 'running', 'attention'],
  'fleet.dashboard.attention.verdict': ['never', 'budget_paused', 'runners_paused', 'waiting_capacity', 'no_fit', 'no_runners', 'fits_not_placed', 'unknown'],
  'fleet.dashboard.attention.condition.credential': ['missing', 'unavailable', 'expired', 'expiring'],
  'fleet.credentials.state': ['ok', 'expiring', 'expired', 'unavailable', 'missing', 'unknown'],
  'fleet.credentials.profiles': ['profile', 'needs', 'needsValue', 'sandbox', 'differs', 'ready', 'absent', 'unknown'],
  'fleet.dashboard.attention.condition.interaction': ['base', 'profile'],
  'fleet.jobs.detail.pipeline.stage': ['stories', 'acceptance', 'regression', 'finish'],
  'fleet.jobs.detail.pipeline.state': ['pending', 'running', 'passed', 'failed', 'skipped', 'unknown'],
  'fleet.jobs.detail.pipeline.view': ['label', 'graph', 'list'],
}

describe('Fleet locale parity (en and zh)', () => {
  test.each(['fleet', 'nav'])('%s has the same keys in en and zh, all non-empty', (subtree) => {
    const enNode = at(en, subtree)
    const zhNode = at(zh, subtree)
    expect(enNode).toBeDefined()
    expect(zhNode).toBeDefined()
    expect(leafPaths(zhNode).sort()).toEqual(leafPaths(enNode).sort())
    for (const leaf of leafPaths(zhNode)) {
      expect(String(at(zhNode as Tree, leaf) ?? '').trim()).not.toBe('')
    }
  })

  test.each(Object.entries(ENUMS))('%s covers exactly the API values', (path, values) => {
    expect(Object.keys(at(en, path) as Tree).sort()).toEqual([...values].sort())
  })

  // Parity, not copy: rewording an English label must not fail a green test.
  test.each(['nav.fleetRunners', 'nav.fleetRepos', 'nav.fleetBudgets', 'nav.fleetApprovals', 'nav.fleetOverview'])('%s is translated in both locales', (key) => {
    expect(String(at(en, key) ?? '').trim()).not.toBe('')
    expect(String(at(zh, key) ?? '').trim()).not.toBe('')
  })

  test('nav has the project fleet jobs link (slice 4c)', () => {
    expect(at(en, 'nav.fleetJobs')).toBe('Fleet jobs')
    expect(at(zh, 'nav.fleetJobs')).toBeTruthy()
  })

  test('the schedule keys the pages render exist (S1b 3b)', () => {
    for (const key of [
      'fleet.schedules.title', 'fleet.schedules.detailTitle', 'fleet.jobs.schedules', 'fleet.jobs.detail.fromSchedule',
      'fleet.jobs.detail.openSchedule', 'fleet.jobs.detail.coalesced', 'fleet.schedules.history.storiesValue',
    ]) {
      expect(String(at(en, key) ?? '').trim()).not.toBe('')
    }
  })

  test('the approval keys the pages render exist (S1.5 1b)', () => {
    for (const key of [
      'fleet.approvals.title', 'fleet.approvals.subtitleProject', 'fleet.approvals.subtitleAdmin', 'fleet.approvals.readOnly',
      'fleet.approvals.linked', 'fleet.approvals.noProject', 'fleet.approvals.filters.allTypes',
      'fleet.approvals.summary.budget', 'fleet.approvals.summary.bash', 'fleet.approvals.budget.raise', 'fleet.approvals.budget.keep',
      'fleet.approvals.outcome.manualResume', 'fleet.approvals.outcome.requeueOk', 'fleet.approvals.badge.label', 'fleet.jobs.approvals',
    ]) {
      expect(String(at(en, key) ?? '').trim()).not.toBe('')
    }
  })

  test('no fleet message uses the vue-i18n plural or linked-message syntax by accident', () => {
    for (const leaf of leafPaths(at(en, 'fleet'))) {
      const value = String(at(en, `fleet.${leaf}`))
      expect(value).not.toMatch(/[|@]/)
    }
  })

  test('the dashboard pins match the wire value lists (D415)', () => {
    expect([...ENUMS['fleet.dashboard.severity']].sort()).toEqual([...SEVERITIES].sort())
    expect([...ENUMS['fleet.dashboard.tiles']].sort()).toEqual([...TILE_IDS].sort())
    expect(ENUMS['fleet.dashboard.attention.verdict'].filter((v) => v !== 'unknown').sort()).toEqual([...UNPLACEABLE_VERDICTS].sort())
    expect([...ENUMS['fleet.dashboard.attention.condition.credential']].sort()).toEqual([...CREDENTIAL_WHY].sort())
    expect(ENUMS['fleet.credentials.state'].filter((s) => s !== 'unknown').sort()).toEqual([...CELL_STATES].sort())
  })
})
