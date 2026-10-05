import { describe, expect, test } from '@jest/globals'
import { attentionLink, attentionMessage, digestChips, renderText, severityOf } from '~/lib/fleet-dashboard'
import type { AttentionMessage } from '~/lib/fleet-dashboard'
import type { AttentionItem } from '~/lib/fleet-dashboard-types'
import { enI18n } from '../helpers/fleet-harness'

const GEN = '2026-10-05T12:00:00.000Z'
const NOW = new Date('2026-10-05T12:00:10.000Z')
const { t, te } = enI18n()

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: 'job_silent:j1', kind: 'job_silent', severity: 'warning', subjectType: 'job', subjectId: 'j1',
  subjectName: 'subtract', projectSlug: 'koda', since: '2026-10-05T11:56:50.000Z', ...over,
})

/** The message as the browser shows it: summary, then one line per detail, then the "more" line. */
function words(m: AttentionMessage): string[] {
  return [
    ...(m.summary ? [renderText(m.summary, t, te)] : []),
    ...m.details.map((d) => renderText(d, t, te)),
    ...(m.more > 0 ? [t('fleet.dashboard.attention.more', { n: m.more })] : []),
  ]
}

describe('attentionMessage (D418)', () => {
  test('a silent running job: heartbeat age advanced to now, and the runner', () => {
    const m = attentionMessage(item({ stage: 'running', silentSec: 190, runnerName: 'wk-mac' }), GEN, NOW)
    expect(words(m)).toEqual(['No heartbeat for 3m on wk-mac'])
  })

  test('an assigned job that never started', () => {
    const m = attentionMessage(item({ stage: 'starting', silentSec: 360, runnerName: 'wk-mac' }), GEN, NOW)
    expect(words(m)).toEqual(['Assigned to wk-mac 6m ago, not started'])
  })

  test('a silent job whose runner name is unknown says so instead of printing null', () => {
    const m = attentionMessage(item({ stage: 'running', silentSec: 200, runnerName: null }), GEN, NOW)
    expect(words(m)).toEqual(['No heartbeat for 3m on Unknown'])
  })

  test('approvals: count and the oldest age', () => {
    const m = attentionMessage(item({ kind: 'job_waiting_approval', key: 'job_waiting_approval:j1', pending: 2, oldestSec: 170 }), GEN, NOW)
    expect(words(m)).toEqual(['2 approval(s) pending, oldest 3m'])
  })

  test('unplaceable: the verdict, one line per shown runner with its translated reason, and the rest counted', () => {
    const m = attentionMessage(item({
      kind: 'job_unplaceable', key: 'job_unplaceable:j1', verdict: 'no_fit',
      reasons: [{ runnerName: 'linux-1', reason: 'provider_missing' }, { runnerName: 'wk-mac', reason: 'offline' }], reasonsTotal: 5,
    }), GEN, NOW)
    expect(words(m)).toEqual([
      'No runner fits right now',
      'linux-1: A profile needs a provider the runner has no credential for',
      'wk-mac: Runner is offline',
      'and 3 more runner(s)',
    ])
  })

  test.each([
    ['never', 'No runner can ever run this'],
    ['budget_paused', 'Budget paused; this job will be cancelled'],
    ['runners_paused', 'Every runner is budget-paused'],
    ['waiting_capacity', 'Waiting for a free runner'],
    ['no_runners', 'No runner can take this job'],
    ['fits_not_placed', 'A runner fits but the job has not been placed'],
  ])('verdict %s', (verdict, text) => {
    expect(words(attentionMessage(item({ kind: 'job_unplaceable', verdict, reasons: [] }), GEN, NOW))).toEqual([text])
  })

  test('a runner: no summary, one line per condition', () => {
    const m = attentionMessage(item({
      kind: 'runner_unhealthy', key: 'runner_unhealthy:r1', subjectType: 'runner', subjectId: 'r1', subjectName: 'wk-mac', projectSlug: null,
      conditions: [
        { type: 'offline', jobsHeld: 2 },
        { type: 'credential', providerId: 'deepseek', why: 'expired' },
        { type: 'credential', providerId: 'anthropic', why: 'missing' },
        { type: 'credential', providerId: 'openai', why: 'unavailable' },
        { type: 'stale_nax', version: '0.83.1', latest: '0.83.3' },
      ],
    }), GEN, NOW)
    expect(m.summary).toBeNull()
    expect(words(m)).toEqual([
      'Offline, holding 2 job(s)',
      'API key for deepseek has expired',
      'No credential for anthropic',
      'Credential for openai is unavailable',
      'nax 0.83.1 is behind 0.83.3',
    ])
  })

  test('project scope: offline without held jobs, and the collapsed configuration condition', () => {
    const m = attentionMessage(item({
      kind: 'runner_unhealthy', subjectType: 'runner', projectSlug: null,
      conditions: [{ type: 'offline', jobsHeld: 0 }, { type: 'configuration' }],
    }), GEN, NOW)
    expect(words(m)).toEqual(['Offline', 'Configuration problem (ask a fleet admin)'])
  })

  test('newer API values degrade to generic text, never a key path (Review Focus 4)', () => {
    expect(words(attentionMessage(item({ kind: 'job_cursed' }), GEN, NOW))).toEqual(['Needs attention'])
    expect(words(attentionMessage(item({ kind: 'job_unplaceable', verdict: 'moon_phase', reasons: [{ runnerName: 'r', reason: 'gremlins' }] }), GEN, NOW)))
      .toEqual(['Not placed', 'r: gremlins'])
    expect(words(attentionMessage(item({ kind: 'runner_unhealthy', conditions: [{ type: 'overheated' }, { type: 'credential', providerId: 'x', why: 'stolen' }] }), GEN, NOW)))
      .toEqual(['Problem: overheated', 'Credential for x is unavailable'])
  })
})

describe('a runner item with no conditions (final review)', () => {
  test('still says it needs attention instead of rendering nothing', () => {
    for (const conditions of [[], undefined]) {
      const m = attentionMessage(item({ kind: 'runner_unhealthy', subjectType: 'runner', projectSlug: null, conditions }), GEN, NOW)
      expect(words(m)).toEqual(['Needs attention'])
    }
  })
})

describe('severityOf and attentionLink (D419)', () => {
  test('anything but error reads as a warning', () => {
    expect(severityOf(item({ severity: 'error' }))).toBe('error')
    expect(severityOf(item({ severity: 'warning' }))).toBe('warning')
    expect(severityOf(item({ severity: 'critical' }))).toBe('warning')
  })

  test('job items open the job page, approval items the inbox, in both scopes', () => {
    expect(attentionLink(item({}), 'global')).toBe('/koda/fleet/jobs/j1')
    expect(attentionLink(item({}), 'project')).toBe('/koda/fleet/jobs/j1')
    expect(attentionLink(item({ kind: 'job_waiting_approval' }), 'project')).toBe('/koda/fleet/approvals')
  })

  test('runner items open the admin Runners page only in the admin scope', () => {
    const runner = item({ kind: 'runner_unhealthy', subjectType: 'runner', subjectId: 'r1', projectSlug: null })
    expect(attentionLink(runner, 'global')).toBe('/admin/fleet/runners')
    expect(attentionLink(runner, 'project')).toBeNull()
  })

  test('a job item without a project slug has no link', () => {
    expect(attentionLink(item({ projectSlug: null }), 'global')).toBeNull()
  })
})

describe('digestChips (D424)', () => {
  const chip = (c: Parameters<typeof digestChips>[0][number]) => {
    const [only] = digestChips([c])
    return [renderText(only.text, t, te), only.tone]
  }

  test('an unavailable credential says so in words', () => {
    expect(chip({ providerId: 'deepseek', available: false, kind: 'api-key', expiresAt: null, expired: false })).toEqual(['deepseek: unavailable', 'bad'])
  })

  test('no stored kind (exec, ambient or none) shows the provider alone', () => {
    expect(chip({ providerId: 'anthropic', available: true, kind: null, expiresAt: null, expired: false })).toEqual(['anthropic', 'ok'])
  })

  test('stored kinds reuse the runners chip keys', () => {
    expect(chip({ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false })).toEqual(['deepseek: API key', 'ok'])
    expect(chip({ providerId: 'claude', available: true, kind: 'oauth', expiresAt: '2026-11-01T00:00:00.000Z', expired: false }))
      .toEqual(['claude: OAuth until 2026-11-01', 'ok'])
    expect(chip({ providerId: 'claude', available: true, kind: 'oauth', expiresAt: '2026-10-01T00:00:00.000Z', expired: true }))
      .toEqual(['claude: OAuth, expired 2026-10-01', 'warn'])
    expect(chip({ providerId: 'x', available: true, kind: 'api-key', expiresAt: null, expired: true })).toEqual(['x: API key, expired', 'warn'])
  })

  test('one chip per credential, keyed by provider', () => {
    expect(digestChips([
      { providerId: 'a', available: true, kind: null, expiresAt: null, expired: false },
      { providerId: 'b', available: true, kind: null, expiresAt: null, expired: false },
    ]).map((c) => c.id)).toEqual(['credential:a', 'credential:b'])
  })
})
