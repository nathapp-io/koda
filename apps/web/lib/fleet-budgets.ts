import * as z from 'zod'
import { formatUsd } from '~/lib/fleet-jobs'
import { BUDGET_RUNNING_JOBS, BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type {
  BudgetPolicyDto, BudgetPolicyPatchBody, BudgetRunningJobs, BudgetScopeType, BudgetWindowKind, NewBudgetPolicyBody,
} from '~/lib/fleet-types'

/** vue-i18n's `t`, narrowed to what the helpers need. */
export type TranslateNamed = (key: string, named?: Record<string, unknown>) => string

/** apps/api create-budget-policy.dto MAX_BUDGET_USD. */
export const MAX_BUDGET_USD = 1_000_000
export const DEFAULT_WARN_PERCENT = 80
export const BANNER_MAX_LINES = 3
/** Decimal(12,4): money has four decimals, so ten-thousandths of a dollar are exact integers. */
const UNITS_PER_USD = 10_000

export type BudgetRouteKind = 'admin' | 'project'

const ADMIN_SCOPES: readonly BudgetScopeType[] = ['global', 'runner']
const PROJECT_SCOPES: readonly BudgetScopeType[] = ['project', 'repo']

/** Plan 2a D162: the scope types each route prefix manages. */
export const scopesFor = (kind: BudgetRouteKind): readonly BudgetScopeType[] => (kind === 'admin' ? ADMIN_SCOPES : PROJECT_SCOPES)

export const isManagedOn = (kind: BudgetRouteKind, policy: Pick<BudgetPolicyDto, 'scopeType'>): boolean =>
  scopesFor(kind).includes(policy.scopeType)

/** Runner and repo policies name a target; global and project ones do not. */
export const needsScopeId = (scopeType: BudgetScopeType): boolean => scopeType === 'runner' || scopeType === 'repo'

/** Scope type, then scope id, then window kind: stable, and the order the pages group by. */
export function sortPolicies(policies: readonly BudgetPolicyDto[]): BudgetPolicyDto[] {
  return [...policies].sort((a, b) =>
    BUDGET_SCOPE_TYPES.indexOf(a.scopeType) - BUDGET_SCOPE_TYPES.indexOf(b.scopeType)
    || (a.scopeId ?? '').localeCompare(b.scopeId ?? '')
    || BUDGET_WINDOW_KINDS.indexOf(a.windowKind) - BUDGET_WINDOW_KINDS.indexOf(b.windowKind))
}

/** Ten-thousandths of a dollar from a decimal string of at most 4 decimals; null when unusable. */
export function toUnits(decimal: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(decimal.trim())
  if (!match) return null
  return BigInt(match[1]) * BigInt(UNITS_PER_USD) + BigInt((match[2] ?? '').padEnd(4, '0'))
}

/**
 * True when `amount` is strictly above `spent`, compared in integer units (never floats). An
 * unparsable value answers true: the server is the authority and will refuse it with its own message.
 */
export function isAboveSpend(amount: string, spent: string): boolean {
  const a = toUnits(amount)
  const s = toUnits(spent)
  if (a === null || s === null) return true
  return a > s
}

const AMOUNT_RE = /^\d{1,7}(?:\.\d{1,4})?$/

/** The create/update `amountUsd`: > 0, at most 4 decimals, at most MAX_BUDGET_USD; null when invalid. */
export function parseAmount(input: string): number | null {
  const trimmed = input.trim()
  if (!AMOUNT_RE.test(trimmed)) return null
  const units = toUnits(trimmed)
  if (units === null || units <= BigInt(0) || units > BigInt(MAX_BUDGET_USD) * BigInt(UNITS_PER_USD)) return null
  return Number(trimmed)
}

export type WarnParse = { ok: true; value: number | null } | { ok: false }

/** Blank = no warning (null); otherwise a whole number 1-99. */
export function parseWarn(input: string): WarnParse {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d{1,2}$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return value >= 1 && value <= 99 ? { ok: true, value } : { ok: false }
}

export interface BudgetFormValues {
  scopeType: BudgetScopeType
  scopeId: string
  windowKind: BudgetWindowKind
  amountUsd: string
  warnPercent: string
  hardStop: 'true' | 'false'
  runningJobs: BudgetRunningJobs
}

/** "5.0000" -> "5", "0.5000" -> "0.5", "12.34" stays. */
function trimDecimal(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal
}

export function initialFormValues(kind: BudgetRouteKind, policy: BudgetPolicyDto | null): BudgetFormValues {
  if (policy === null) {
    return {
      scopeType: scopesFor(kind)[0], scopeId: '', windowKind: 'calendar_month_utc', amountUsd: '',
      warnPercent: String(DEFAULT_WARN_PERCENT), hardStop: 'true', runningJobs: 'finish',
    }
  }
  return {
    scopeType: policy.scopeType,
    scopeId: policy.scopeId ?? '',
    windowKind: policy.windowKind,
    amountUsd: trimDecimal(policy.amountUsd),
    warnPercent: policy.warnPercent === null ? '' : String(policy.warnPercent),
    hardStop: policy.hardStop ? 'true' : 'false',
    runningJobs: policy.runningJobs,
  }
}

/** The create/edit form. Mirrors the DTO validators; the server's message is still shown for anything else. */
export function buildBudgetSchema(t: TranslateNamed) {
  return z.object({
    scopeType: z.enum(BUDGET_SCOPE_TYPES),
    // Tolerant (D182 note): vee-validate unsets a field's value when its input unmounts (the scope-id
    // select is under v-if), so after runner -> global the value is undefined, not ''.
    scopeId: z.string().default(''),
    windowKind: z.enum(BUDGET_WINDOW_KINDS),
    amountUsd: z.string().refine((value) => parseAmount(value) !== null, t('fleet.budgets.validation.amountInvalid')),
    warnPercent: z.string().refine((value) => parseWarn(value).ok, t('fleet.budgets.validation.warnInvalid')),
    hardStop: z.enum(['true', 'false']),
    runningJobs: z.enum(BUDGET_RUNNING_JOBS),
  }).superRefine((value, ctx) => {
    if (needsScopeId(value.scopeType) && value.scopeId.trim() === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeId'], message: t('fleet.budgets.validation.scopeRequired') })
    }
  })
}

function validated(values: BudgetFormValues): { amountUsd: number; warnPercent: number | null } {
  const amountUsd = parseAmount(values.amountUsd)
  const warn = parseWarn(values.warnPercent)
  if (amountUsd === null || !warn.ok) throw new Error('fleet-budgets: form values were not validated')
  return { amountUsd, warnPercent: warn.value }
}

export function toCreateBody(values: BudgetFormValues): NewBudgetPolicyBody {
  const { amountUsd, warnPercent } = validated(values)
  return {
    scopeType: values.scopeType,
    ...(needsScopeId(values.scopeType) ? { scopeId: values.scopeId } : {}),
    windowKind: values.windowKind,
    amountUsd,
    warnPercent,
    hardStop: values.hardStop === 'true',
    runningJobs: values.runningJobs,
  }
}

/** D183: all four editable fields, always, so a blank warn field really turns warnings off. */
export function toPatchBody(values: BudgetFormValues): BudgetPolicyPatchBody {
  const { amountUsd, warnPercent } = validated(values)
  return { amountUsd, warnPercent, hardStop: values.hardStop === 'true', runningJobs: values.runningJobs }
}

/** D184: blank keeps the amount only when it is still above the spend; a typed amount must be above it. */
export function buildResumeSchema(t: TranslateNamed, policy: Pick<BudgetPolicyDto, 'amountUsd' | 'spentUsd'>) {
  return z.object({
    amountUsd: z.string().superRefine((value, ctx) => {
      const trimmed = value.trim()
      if (trimmed === '') {
        if (!isAboveSpend(policy.amountUsd, policy.spentUsd)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('fleet.budgets.validation.amountRequired') })
        }
        return
      }
      if (parseAmount(trimmed) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('fleet.budgets.validation.amountInvalid') })
        return
      }
      if (!isAboveSpend(trimmed, policy.spentUsd)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('fleet.budgets.validation.resumeNotAbove', { spent: formatUsd(policy.spentUsd) }),
        })
      }
    }),
  })
}

export function toResumeAmount(input: string): number | undefined {
  const trimmed = input.trim()
  return trimmed === '' ? undefined : (parseAmount(trimmed) ?? undefined)
}

export type BudgetStatus = 'paused' | 'warning' | 'ok'

/** The server's flags decide (D181); the client never recomputes a pause or a warn. */
export function budgetStatus(policy: Pick<BudgetPolicyDto, 'paused' | 'warnReached'>): BudgetStatus {
  if (policy.paused) return 'paused'
  return policy.warnReached ? 'warning' : 'ok'
}

/** Display only: integer-floored (so 100 shows only at or past the limit) and exact, e.g. 0.57 of 1 is 57. */
export function spendPercent(spent: string, amount: string): number {
  const s = toUnits(spent)
  const a = toUnits(amount)
  if (s === null || a === null || a <= BigInt(0)) return 0
  const percent = (s * BigInt(100)) / a
  return percent > BigInt(100) ? 100 : Number(percent)
}

export interface BannerLine {
  policy: BudgetPolicyDto
  status: 'paused' | 'warning'
}

/** D179: paused first, then warnings, at most BANNER_MAX_LINES; `more` counts the rest. */
export function bannerLines(policies: readonly BudgetPolicyDto[]): { lines: BannerLine[]; more: number } {
  const flagged = policies.flatMap((policy): BannerLine[] => {
    const status = budgetStatus(policy)
    return status === 'ok' ? [] : [{ policy, status }]
  })
  const ordered = [...flagged.filter((l) => l.status === 'paused'), ...flagged.filter((l) => l.status === 'warning')]
  return { lines: ordered.slice(0, BANNER_MAX_LINES), more: Math.max(0, ordered.length - BANNER_MAX_LINES) }
}

export interface ScopeNames {
  project: string | null
  repo: (id: string) => string
  runner: (id: string) => string
}

/** The name behind a policy's scope; null for global (and for a repo/runner policy without a scope id). */
export function scopeName(policy: Pick<BudgetPolicyDto, 'scopeType' | 'scopeId'>, names: ScopeNames): string | null {
  switch (policy.scopeType) {
    case 'global': return null
    case 'project': return names.project ?? policy.scopeId
    case 'repo': return policy.scopeId === null ? null : names.repo(policy.scopeId)
    case 'runner': return policy.scopeId === null ? null : names.runner(policy.scopeId)
  }
}

/** "the whole fleet" / "project x" / "repo a/b" / "runner r", for sentences. */
export function scopeText(t: TranslateNamed, policy: Pick<BudgetPolicyDto, 'scopeType'>, name: string | null): string {
  return t(`fleet.budgets.scopeText.${policy.scopeType}`, { name: name ?? '' })
}

/** The window start is an ISO instant; its UTC date is what a monthly window "starts". */
export const windowSinceDate = (iso: string): string => iso.slice(0, 10)

const BUDGET_STOP_RE = /^budget:([A-Za-z0-9_-]{1,64})$/

/** D188: the policy id inside a job's `stateReason` when a budget stopped it (2a D156), else null. */
export function budgetStopPolicyId(reason: string | null | undefined): string | null {
  if (!reason) return null
  return BUDGET_STOP_RE.exec(reason)?.[1] ?? null
}
