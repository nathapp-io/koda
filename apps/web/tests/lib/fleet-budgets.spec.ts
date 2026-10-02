import { describe, expect, test } from '@jest/globals'
import {
  BANNER_MAX_LINES, bannerLines, budgetStatus, budgetStopPolicyId, buildBudgetSchema, buildResumeSchema, initialFormValues,
  isAboveSpend, isManagedOn, needsScopeId, parseAmount, parseWarn, scopeName, scopeText, scopesFor, sortPolicies,
  spendPercent, toCreateBody, toPatchBody, toResumeAmount, toUnits, windowSinceDate,
} from '../../lib/fleet-budgets'
import type { BudgetFormValues } from '../../lib/fleet-budgets'
import type { BudgetPolicyDto } from '../../lib/fleet-types'

const policy = (over: Partial<BudgetPolicyDto> = {}): BudgetPolicyDto => ({
  id: 'p1', scopeType: 'project', scopeId: 'proj1', projectId: 'proj1', windowKind: 'calendar_month_utc',
  amountUsd: '5.0000', warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null,
  windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '1.0000', warnReached: false, updatedById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})

/** Echoes the key and its named values so an assertion can see which message and arguments were used. */
const t = (key: string, named: Record<string, unknown> = {}): string =>
  Object.keys(named).length > 0 ? `${key}${JSON.stringify(named)}` : key

const values = (over: Partial<BudgetFormValues> = {}): BudgetFormValues => ({
  scopeType: 'global', scopeId: '', windowKind: 'calendar_month_utc', amountUsd: '10', warnPercent: '80',
  hardStop: 'true', runningJobs: 'finish', ...over,
})

describe('toUnits and isAboveSpend (decimal-safe, no floats)', () => {
  test.each([
    ['5.0000', 50000], ['0.3', 3000], ['12', 120000], ['0.0001', 1], [' 7.5 ', 75000],
  ])('toUnits(%p) = %p ten-thousandths', (input, units) => {
    expect(toUnits(input)).toBe(BigInt(units))
  })

  test.each([[''], ['-1'], ['1e-7'], ['0.12345'], ['abc'], ['1,5']])('toUnits(%p) is null', (input) => {
    expect(toUnits(input)).toBeNull()
  })

  test('an amount equal to the spend is not above it, whatever the trailing zeros', () => {
    expect(isAboveSpend('0.3', '0.3000')).toBe(false)
    expect(isAboveSpend('5', '5.0000')).toBe(false)
    expect(isAboveSpend('0.3001', '0.3')).toBe(true)
    expect(isAboveSpend('5.0001', '5.0000')).toBe(true)
    expect(isAboveSpend('4', '4.5')).toBe(false)
  })

  test('an unparsable value lets the server decide', () => {
    expect(isAboveSpend('x', '1')).toBe(true)
    expect(isAboveSpend('1', 'x')).toBe(true)
  })
})

describe('parseAmount and parseWarn', () => {
  test.each([
    ['0.5', 0.5], ['1000000', 1000000], ['0.0001', 0.0001], [' 2 ', 2], ['12.3456', 12.3456],
  ])('parseAmount(%p) = %p', (input, out) => {
    expect(parseAmount(input)).toBe(out)
  })

  test.each([[''], ['0'], ['0.0000'], ['1000000.0001'], ['12345678'], ['1.23456'], ['1e3'], ['1,5'], ['-2'], ['abc']])(
    'parseAmount(%p) is null',
    (input) => { expect(parseAmount(input)).toBeNull() },
  )

  test('parseWarn: blank is "no warn", 1-99 is a percent, anything else is rejected', () => {
    expect(parseWarn('')).toEqual({ ok: true, value: null })
    expect(parseWarn('  ')).toEqual({ ok: true, value: null })
    expect(parseWarn('80')).toEqual({ ok: true, value: 80 })
    expect(parseWarn(' 5 ')).toEqual({ ok: true, value: 5 })
    for (const bad of ['0', '100', '8.5', '-1', 'abc', '07x']) expect(parseWarn(bad)).toEqual({ ok: false })
  })
})

describe('scopes, ordering and ownership', () => {
  test('each route manages its own scope types (2a D162)', () => {
    expect(scopesFor('admin')).toEqual(['global', 'runner'])
    expect(scopesFor('project')).toEqual(['project', 'repo'])
    expect(isManagedOn('admin', policy({ scopeType: 'runner' }))).toBe(true)
    expect(isManagedOn('admin', policy({ scopeType: 'project' }))).toBe(false)
    expect(isManagedOn('project', policy({ scopeType: 'global' }))).toBe(false)
    expect(isManagedOn('project', policy({ scopeType: 'repo' }))).toBe(true)
  })

  test('needsScopeId is true for runner and repo only', () => {
    expect(['global', 'project', 'repo', 'runner'].map((s) => needsScopeId(s as never))).toEqual([false, false, true, true])
  })

  test('sortPolicies orders by scope type, then scope id, then window', () => {
    const rows = [
      policy({ id: 'a', scopeType: 'runner', scopeId: 'r2' }),
      policy({ id: 'b', scopeType: 'global', scopeId: null, windowKind: 'lifetime' }),
      policy({ id: 'c', scopeType: 'global', scopeId: null, windowKind: 'calendar_month_utc' }),
      policy({ id: 'd', scopeType: 'runner', scopeId: 'r1' }),
    ]
    expect(sortPolicies(rows).map((p) => p.id)).toEqual(['c', 'b', 'd', 'a'])
    expect(rows.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('labels and display helpers', () => {
  test('scopeName resolves names, falls back to the raw id and is null for global', () => {
    const names = { project: 'koda', repo: (id: string) => (id === 'r1' ? 'acme/app' : id), runner: (id: string) => `box-${id}` }
    expect(scopeName(policy({ scopeType: 'global', scopeId: null }), names)).toBeNull()
    expect(scopeName(policy({ scopeType: 'project' }), names)).toBe('koda')
    expect(scopeName(policy({ scopeType: 'repo', scopeId: 'r1' }), names)).toBe('acme/app')
    expect(scopeName(policy({ scopeType: 'repo', scopeId: 'gone' }), names)).toBe('gone')
    expect(scopeName(policy({ scopeType: 'runner', scopeId: '7' }), names)).toBe('box-7')
    expect(scopeName(policy({ scopeType: 'repo', scopeId: null }), names)).toBeNull()
  })

  test('scopeText asks the translator for the scope sentence', () => {
    expect(scopeText(t, policy({ scopeType: 'repo' }), 'acme/app')).toBe('fleet.budgets.scopeText.repo{"name":"acme/app"}')
    expect(scopeText(t, policy({ scopeType: 'global', scopeId: null }), null)).toBe('fleet.budgets.scopeText.global{"name":""}')
  })

  test('spendPercent floors, clamps and survives garbage', () => {
    expect(spendPercent('4.99', '5')).toBe(99)
    expect(spendPercent('5', '5')).toBe(100)
    expect(spendPercent('9', '5')).toBe(100)
    expect(spendPercent('0', '5')).toBe(0)
    expect(spendPercent('0.57', '1')).toBe(57)
    expect(spendPercent('x', '5')).toBe(0)
    expect(spendPercent('1', '0')).toBe(0)
  })

  test('budgetStatus follows the server flags: paused beats warning', () => {
    expect(budgetStatus({ paused: true, warnReached: true })).toBe('paused')
    expect(budgetStatus({ paused: false, warnReached: true })).toBe('warning')
    expect(budgetStatus({ paused: false, warnReached: false })).toBe('ok')
  })

  test('windowSinceDate is the UTC date of the window start', () => {
    expect(windowSinceDate('2026-10-01T00:00:00.000Z')).toBe('2026-10-01')
    expect(windowSinceDate('1970-01-01T00:00:00.000Z')).toBe('1970-01-01')
  })

  test('budgetStopPolicyId reads the reason a budget cancel writes (2a D156)', () => {
    expect(budgetStopPolicyId('budget:ckx123')).toBe('ckx123')
    for (const other of ['budget:', 'budget:a b', 'cancelled before start', '', null, undefined]) {
      expect(budgetStopPolicyId(other)).toBeNull()
    }
  })
})

describe('bannerLines', () => {
  const flagged = (id: string, over: Partial<BudgetPolicyDto>) => policy({ id, ...over })

  test('paused first, then warnings, ok rows hidden', () => {
    const { lines, more } = bannerLines([
      flagged('w1', { warnReached: true }),
      flagged('ok', {}),
      flagged('p1', { paused: true }),
    ])
    expect(lines.map((l) => [l.policy.id, l.status])).toEqual([['p1', 'paused'], ['w1', 'warning']])
    expect(more).toBe(0)
  })

  test('at most three lines, the rest counted', () => {
    const rows = [
      flagged('p1', { paused: true }), flagged('p2', { paused: true }), flagged('w1', { warnReached: true }),
      flagged('w2', { warnReached: true }), flagged('w3', { warnReached: true }),
    ]
    const { lines, more } = bannerLines(rows)
    expect(lines).toHaveLength(BANNER_MAX_LINES)
    expect(lines.map((l) => l.policy.id)).toEqual(['p1', 'p2', 'w1'])
    expect(more).toBe(2)
  })

  test('a paused policy that is also past its warn threshold appears once', () => {
    const { lines } = bannerLines([flagged('p1', { paused: true, warnReached: true })])
    expect(lines).toHaveLength(1)
    expect(lines[0].status).toBe('paused')
  })

  test('nothing flagged, nothing shown', () => {
    expect(bannerLines([])).toEqual({ lines: [], more: 0 })
    expect(bannerLines([flagged('ok', {})])).toEqual({ lines: [], more: 0 })
  })
})

describe('form values and bodies', () => {
  test('initialFormValues for a new policy depends on the route', () => {
    expect(initialFormValues('admin', null)).toEqual(values({ amountUsd: '' }))
    expect(initialFormValues('project', null).scopeType).toBe('project')
  })

  test('initialFormValues for an existing policy trims trailing zeros and maps null warn to blank', () => {
    expect(initialFormValues('project', policy({ amountUsd: '5.0000', warnPercent: null, hardStop: false, runningJobs: 'cancel' }))).toEqual({
      scopeType: 'project', scopeId: 'proj1', windowKind: 'calendar_month_utc', amountUsd: '5', warnPercent: '',
      hardStop: 'false', runningJobs: 'cancel',
    })
    expect(initialFormValues('admin', policy({ scopeType: 'global', scopeId: null, amountUsd: '0.5000' })).amountUsd).toBe('0.5')
    expect(initialFormValues('admin', policy({ amountUsd: '12.3400' })).amountUsd).toBe('12.34')
    expect(initialFormValues('admin', policy({ amountUsd: '100' })).amountUsd).toBe('100')
  })

  test('toCreateBody sends scopeId for runner and repo only, blank warn as null, hardStop as boolean', () => {
    expect(toCreateBody(values())).toEqual({
      scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 10, warnPercent: 80, hardStop: true, runningJobs: 'finish',
    })
    expect(toCreateBody(values({ scopeType: 'runner', scopeId: 'r1', warnPercent: '', hardStop: 'false', runningJobs: 'cancel' }))).toEqual({
      scopeType: 'runner', scopeId: 'r1', windowKind: 'calendar_month_utc', amountUsd: 10, warnPercent: null, hardStop: false, runningJobs: 'cancel',
    })
    expect(toCreateBody(values({ scopeType: 'project', scopeId: 'stale' }))).not.toHaveProperty('scopeId')
  })

  test('toCreateBody refuses values the schema never validated', () => {
    expect(() => toCreateBody(values({ amountUsd: 'abc' }))).toThrow('not validated')
    expect(() => toCreateBody(values({ warnPercent: '100' }))).toThrow('not validated')
  })

  test('toPatchBody always sends the four editable fields, including an explicit null warn', () => {
    expect(toPatchBody(values({ amountUsd: '7.25', warnPercent: '' }))).toEqual({
      amountUsd: 7.25, warnPercent: null, hardStop: true, runningJobs: 'finish',
    })
  })
})

describe('buildBudgetSchema', () => {
  const schema = buildBudgetSchema(t)
  const issuePaths = (input: BudgetFormValues): string[] => {
    const result = schema.safeParse(input)
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
  }

  test('a complete global policy passes; blank warn passes', () => {
    expect(issuePaths(values())).toEqual([])
    expect(issuePaths(values({ warnPercent: '' }))).toEqual([])
  })

  test('amount and warn errors name their field and use i18n keys', () => {
    expect(issuePaths(values({ amountUsd: '' }))).toEqual(['amountUsd'])
    expect(issuePaths(values({ warnPercent: '150' }))).toEqual(['warnPercent'])
    const result = schema.safeParse(values({ amountUsd: '0' }))
    expect(result.success ? '' : result.error.issues[0].message).toBe('fleet.budgets.validation.amountInvalid')
  })

  test('a scope id unset by an unmounted field is tolerated for global and project, still required for runner and repo', () => {
    const rest: Partial<BudgetFormValues> = values({ scopeType: 'global' })
    delete rest.scopeId
    expect(schema.safeParse(rest).success).toBe(true)
    expect(schema.safeParse({ ...rest, scopeType: 'project' }).success).toBe(true)
    const runner = schema.safeParse({ ...rest, scopeType: 'runner' })
    expect(runner.success ? [] : runner.error.issues.map((i) => i.path.join('.'))).toEqual(['scopeId'])
  })

  test('runner and repo need a target, global and project do not', () => {
    expect(issuePaths(values({ scopeType: 'runner', scopeId: '' }))).toEqual(['scopeId'])
    expect(issuePaths(values({ scopeType: 'repo', scopeId: '' }))).toEqual(['scopeId'])
    expect(issuePaths(values({ scopeType: 'runner', scopeId: 'r1' }))).toEqual([])
    expect(issuePaths(values({ scopeType: 'project', scopeId: '' }))).toEqual([])
  })
})

describe('buildResumeSchema (D184)', () => {
  const run = (amountUsd: string, over: Partial<Pick<BudgetPolicyDto, 'amountUsd' | 'spentUsd'>> = {}) =>
    buildResumeSchema(t, { amountUsd: '10.0000', spentUsd: '9.0000', ...over }).safeParse({ amountUsd })

  test('blank keeps the amount when it is above the spend', () => {
    expect(run('').success).toBe(true)
  })

  test('blank is refused when the limit is not above the spend (lowered amount)', () => {
    const lowered = run('', { amountUsd: '2.0000', spentUsd: '3.0000' })
    expect(lowered.success).toBe(false)
    expect(lowered.success ? '' : lowered.error.issues[0].message).toBe('fleet.budgets.validation.amountRequired')
    expect(run('', { amountUsd: '3.0000', spentUsd: '3.0000' }).success).toBe(false)
  })

  test('a typed amount must be above the spend, decimal-exact', () => {
    expect(run('9', { spentUsd: '9.0000' }).success).toBe(false)
    expect(run('9.0001', { spentUsd: '9.0000' }).success).toBe(true)
    const refused = run('5', { spentUsd: '9.0000' })
    expect(refused.success ? '' : refused.error.issues[0].message).toContain('fleet.budgets.validation.resumeNotAbove')
  })

  test('a malformed amount is refused', () => {
    const bad = run('abc')
    expect(bad.success ? '' : bad.error.issues[0].message).toBe('fleet.budgets.validation.amountInvalid')
  })

  test('toResumeAmount: blank is "keep", otherwise the number', () => {
    expect(toResumeAmount('')).toBeUndefined()
    expect(toResumeAmount('  ')).toBeUndefined()
    expect(toResumeAmount(' 7.5 ')).toBe(7.5)
  })
})
