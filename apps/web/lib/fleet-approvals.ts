/**
 * The fleet half of the approval surface. US-010 retired the fleet inbox (its components, composables and page code
 * are gone) but the fleet shells — the job page, the header badge, the notification bell, the thread action card and
 * the engine's fleet panels (`lib/approval-request-fleet.ts`) — still read the same payloads, countdowns, delivery
 * acks and re-queue failures through the helpers below.
 */
import { isAboveSpend, parseAmount } from '~/lib/fleet-budgets'
import { BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type { BudgetScopeType, BudgetWindowKind } from '~/lib/fleet-types'

/** Above this the header badge reads `99+`. */
export const BADGE_CAP = 99

/** Spec §1.2 budget payload at the time of the stop. */
export interface BudgetApprovalPayload {
  scopeType: BudgetScopeType
  scopeId: string | null
  windowKind: BudgetWindowKind
  windowStart: string
  spentUsd: string
  amountUsd: string
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** A payload arrives from the wire, so every reader narrows it here instead of trusting an obsolete DTO. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The discriminators a budget ask is reached under: the retired fleet adapter's own type, which the engine budget
 * panel still passes for its frozen input (`budgetAskOf`), and the engine's plain-object `budget_override` (US-007
 * AC-2). Both carry the same six fields.
 */
const BUDGET_ASK_TYPES: readonly string[] = ['budget_override_required', 'budget_override']

/** The budget payload, or null for another type or a payload that does not have the shape (Review Focus 5). */
export function budgetPayload(a: { type: string; payload: unknown }): BudgetApprovalPayload | null {
  if (!BUDGET_ASK_TYPES.includes(a.type)) return null
  const p = a.payload
  if (!isRecord(p)) return null
  const scopeId = p.scopeId ?? null
  if (!(BUDGET_SCOPE_TYPES as readonly unknown[]).includes(p.scopeType)) return null
  if (!(BUDGET_WINDOW_KINDS as readonly unknown[]).includes(p.windowKind)) return null
  if (!isString(p.windowStart) || !isString(p.spentUsd) || !isString(p.amountUsd)) return null
  if (scopeId !== null && !isString(scopeId)) return null
  return {
    scopeType: p.scopeType as BudgetScopeType,
    scopeId,
    windowKind: p.windowKind as BudgetWindowKind,
    windowStart: p.windowStart,
    spentUsd: p.spentUsd,
    amountUsd: p.amountUsd,
  }
}

/** The choices nax offers on a bash ask (2a `ApprovalOption`). */
const APPROVAL_OPTIONS = ['allow', 'allow-remember', 'deny'] as const
type ApprovalOption = (typeof APPROVAL_OPTIONS)[number]

/** Spec §1.2 bash payload; `rawDetail` is null when the runner parsed nax's text. */
export interface BashApprovalPayload {
  command: string
  commandTruncated: boolean
  maskedCount: number
  root: string
  stage: string
  storyId: string | null
  featureName: string
  reason: string
  options: ApprovalOption[]
  rawDetail: string | null
}

const isOption = (value: unknown): value is ApprovalOption => (APPROVAL_OPTIONS as readonly unknown[]).includes(value)

/** D289: the bash payload, or null for another type or a payload without the shape (only Deny is then offered). */
export function bashPayload(a: { type: string; payload: unknown }): BashApprovalPayload | null {
  if (a.type !== 'nax_bash_escalate') return null
  const p = a.payload
  if (!isRecord(p)) return null
  const storyId = p.storyId ?? null
  const rawDetail = p.rawDetail ?? null
  if (!isString(p.command) || typeof p.commandTruncated !== 'boolean') return null
  if (typeof p.maskedCount !== 'number' || !Number.isInteger(p.maskedCount) || p.maskedCount < 0) return null
  if (!isString(p.root) || !isString(p.stage) || !isString(p.featureName) || !isString(p.reason)) return null
  if (storyId !== null && !isString(storyId)) return null
  if (rawDetail !== null && !isString(rawDetail)) return null
  if (!Array.isArray(p.options) || p.options.length === 0 || !p.options.every(isOption)
    || new Set(p.options).size !== p.options.length || !p.options.includes('deny')) return null
  if (p.command === '' && (rawDetail === null || rawDetail === '')) return null   // nothing a human could read
  return {
    command: p.command, commandTruncated: p.commandTruncated, maskedCount: p.maskedCount, root: p.root, stage: p.stage,
    storyId, featureName: p.featureName, reason: p.reason, options: [...p.options], rawDetail,
  }
}

export type BashDecision = 'allow' | 'allow_for_job' | 'deny'

/** D291 (2a `checkBashDecision`): a cut or unreadable ask is deny-only; otherwise only what nax offered, then deny. */
export function bashChoices(p: BashApprovalPayload | null): BashDecision[] {
  if (p === null || p.commandTruncated) return ['deny']
  return [
    ...(p.options.includes('allow') ? ['allow' as const] : []),
    ...(p.options.includes('allow-remember') ? ['allow_for_job' as const] : []),
    'deny',
  ]
}

export type RaiseError = 'amountInvalid' | 'notAbove' | null

/** D243: the new limit must parse and sit above the spend recorded at the stop (the server re-checks the live spend). */
export function raiseAmountError(input: string, spentUsd: string): RaiseError {
  const trimmed = input.trim()
  if (parseAmount(trimmed) === null) return 'amountInvalid'
  return isAboveSpend(trimmed, spentUsd) ? null : 'notAbove'
}

/** D292: whole seconds before nax denies the ask, 0 once passed; null without a readable expiry. */
export function secondsLeft(expiresAt: string | null, now: Date): number | null {
  if (expiresAt === null) return null
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000))
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** D292: `m:ss`, or `h:mm:ss` from an hour (a skewed expiry can sit past the 60-minute cap). */
export function countdownText(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

export type DeliveryView = { state: 'delivered' } | { state: 'failed'; detail: string | null } | { state: 'waiting' }

/**
 * D294 (2a D268): the runner's ack of the answer, for a bash ask a user decided. Null where nothing was sent (a
 * timeout or job-end close, or a budget approval). An unknown stored shape reads as failed: never a false "delivered".
 */
export function deliveryView(
  a: { type: string; resolvedBy: string | null; outcome: unknown },
): DeliveryView | null {
  if (a.type !== 'nax_bash_escalate' || a.resolvedBy !== 'user') return null
  const raw = isRecord(a.outcome) ? a.outcome.delivery : undefined
  if (raw === undefined || raw === null) return { state: 'waiting' }
  if (typeof raw !== 'object') return { state: 'failed', detail: null }
  const { result, detail } = raw as { result?: unknown; detail?: unknown }
  if (result === 'ok') return { state: 'delivered' }
  return { state: 'failed', detail: result === 'rejected' && isString(detail) ? detail : null }
}

const PREVIEW_CHARS = 80

/** D296: the first line of the command (or of nax's raw text), cut at 80 characters; `...` marks anything left out. */
export function commandPreview(p: BashApprovalPayload): string {
  const text = p.command !== '' ? p.command : (p.rawDetail ?? '')
  const first = text.split('\n')[0] ?? ''
  if (first.length > PREVIEW_CHARS) return `${first.slice(0, PREVIEW_CHARS)}...`
  return text.includes('\n') ? `${first}...` : first
}

export const REQUEUE_FAILURES = ['gone', 'activeJob', 'notCancelled', 'paused', 'unknown'] as const
export type RequeueFailure = (typeof REQUEUE_FAILURES)[number]

/** D245: the reason behind a stored 1a `errorText` (`{"code","args"}` JSON or "unexpected error"). */
export function requeueFailure(error: unknown): RequeueFailure {
  if (!isString(error)) return 'unknown'
  let parsed: unknown
  try {
    parsed = JSON.parse(error)
  } catch {
    return 'unknown'
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown'
  const { code, args } = parsed as { code?: unknown; args?: unknown }
  switch (code) {
    case 'fleet.jobs':
      return args !== null && typeof args === 'object' && 'activeJobId' in args ? 'activeJob' : 'gone'
    case 'fleet.jobState':
      return 'notCancelled'
    case 'fleet.budgetPaused':
      return 'paused'
    default:
      return 'unknown'
  }
}

export const badgeText = (total: number): string => (total > BADGE_CAP ? `${BADGE_CAP}+` : String(total))
