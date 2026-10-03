import * as z from 'zod'
import { isAboveSpend, parseAmount, scopeText } from '~/lib/fleet-budgets'
import type { TranslateNamed } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'
import { BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type {
  ApprovalCountsDto, ApprovalType, BudgetScopeType, BudgetWindowKind, DecideApprovalBody, FleetApprovalDto,
} from '~/lib/fleet-types'

/** D240: the Pending tab is one page of this many; All pages by INBOX_PAGE_SIZE. */
export const INBOX_PENDING_SIZE = 100
export const INBOX_PAGE_SIZE = 20
export const BADGE_CAP = 99
/** apps/api decide-approval.dto `comment` MaxLength. */
export const MAX_COMMENT = 1000

export type ApprovalBase = { kind: 'admin' } | { kind: 'project'; slug: string }
/** D290: `canManage` = project ADMIN (budget overrides), `canWork` = DEVELOPER+ (bash asks), both from the members endpoint. */
export type ApprovalViewer = { kind: 'admin' } | { kind: 'project'; canManage: boolean; canWork: boolean }

export const INBOX_TABS = ['pending', 'all'] as const
export type InboxTab = (typeof INBOX_TABS)[number]

export interface ApprovalListFilters {
  tab: InboxTab
  type?: ApprovalType
  page?: number
}

/** Only set filters reach the query; `current` only past page 1 on the All tab (D240). */
export function buildApprovalQuery(f: ApprovalListFilters): Record<string, string> {
  return {
    ...(f.tab === 'pending' ? { status: 'pending' } : {}),
    ...(f.type ? { type: f.type } : {}),
    size: String(f.tab === 'pending' ? INBOX_PENDING_SIZE : INBOX_PAGE_SIZE),
    ...(f.tab === 'all' && f.page !== undefined && f.page > 1 ? { current: String(f.page) } : {}),
  }
}

/** D240: soonest `expiresAt` first (ISO instants compare as strings), then rows without one in their given order. */
export function sortPending(rows: readonly FleetApprovalDto[]): FleetApprovalDto[] {
  const expiring = rows
    .filter((r) => r.expiresAt !== null)
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') || a.id.localeCompare(b.id))
  return [...expiring, ...rows.filter((r) => r.expiresAt === null)]
}

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

/** The budget payload, or null for another type or a payload that does not have the shape (Review Focus 5). */
export function budgetPayload(a: Pick<FleetApprovalDto, 'type' | 'payload'>): BudgetApprovalPayload | null {
  if (a.type !== 'budget_override_required') return null
  const p = a.payload
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
export const APPROVAL_OPTIONS = ['allow', 'allow-remember', 'deny'] as const
export type ApprovalOption = (typeof APPROVAL_OPTIONS)[number]

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
export function bashPayload(a: Pick<FleetApprovalDto, 'type' | 'payload'>): BashApprovalPayload | null {
  if (a.type !== 'nax_bash_escalate') return null
  const p = a.payload
  const storyId = p.storyId ?? null
  const rawDetail = p.rawDetail ?? null
  if (!isString(p.command) || typeof p.commandTruncated !== 'boolean') return null
  if (typeof p.maskedCount !== 'number' || !Number.isInteger(p.maskedCount) || p.maskedCount < 0) return null
  if (!isString(p.root) || !isString(p.stage) || !isString(p.featureName) || !isString(p.reason)) return null
  if (storyId !== null && !isString(storyId)) return null
  if (rawDetail !== null && !isString(rawDetail)) return null
  if (!Array.isArray(p.options) || !p.options.every(isOption)) return null
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

/** Spec §1.7 (D244, D290): budget overrides by project ADMIN, bash asks by DEVELOPER+, everything on the admin inbox. */
export function canDecide(a: Pick<FleetApprovalDto, 'type' | 'status'>, viewer: ApprovalViewer): boolean {
  if (a.status !== 'pending') return false
  if (viewer.kind === 'admin') return true
  return a.type === 'budget_override_required' ? viewer.canManage : viewer.canWork
}

export type RaiseError = 'amountInvalid' | 'notAbove' | null

/** D243: the new limit must parse and sit above the spend recorded at the stop (the server re-checks the live spend). */
export function raiseAmountError(input: string, spentUsd: string): RaiseError {
  const trimmed = input.trim()
  if (parseAmount(trimmed) === null) return 'amountInvalid'
  return isAboveSpend(trimmed, spentUsd) ? null : 'notAbove'
}

export const commentTooLong = (comment: string): boolean => comment.trim().length > MAX_COMMENT

const commentField = (comment: string): { comment?: string } => {
  const trimmed = comment.trim()
  return trimmed === '' ? {} : { comment: trimmed }
}

/** D243: `requeueJobIds` always sent, `[]` when nothing is ticked (D231: omitted would also mean none). */
export function toRaiseBody(input: { amount: string; selected: readonly string[]; comment: string }): DecideApprovalBody {
  const amountUsd = parseAmount(input.amount.trim())
  if (amountUsd === null) throw new Error('fleet-approvals: amount was not validated')
  return { decision: 'raise_budget_and_resume', amountUsd, requeueJobIds: [...input.selected], ...commentField(input.comment) }
}

export const toKeepPausedBody = (comment: string): DecideApprovalBody => ({ decision: 'keep_paused', ...commentField(comment) })

/** D293: a bash decide never carries budget fields (2a D287 answers 400). */
export const toBashBody = (decision: BashDecision, comment: string): DecideApprovalBody => ({ decision, ...commentField(comment) })

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
export function deliveryView(a: Pick<FleetApprovalDto, 'type' | 'resolvedBy' | 'outcome'>): DeliveryView | null {
  if (a.type !== 'nax_bash_escalate' || a.resolvedBy !== 'user') return null
  const raw = a.outcome?.delivery
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

/** D297: the job's pending ask that nax denies first (the job-page callout opens it). */
export const firstPending = (rows: readonly FleetApprovalDto[]): FleetApprovalDto | null =>
  sortPending(rows.filter((r) => r.status === 'pending'))[0] ?? null

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

export interface RequeueResultView {
  jobId: string
  ok: boolean
  reason: RequeueFailure | null
}

/**
 * D245: the re-queue record of a raise decided in the inbox. Null for anything else, including a manual resume, whose
 * stored `[]` means "not offered", not "none selected" (#193 deferred item 2). Malformed entries are skipped.
 * Known gap: between the decide's first commit and its final `setOutcome` (or if the API dies there) a raise is
 * stored with `requeueResults: []`, which reads as "none selected". Rare and self-healing once the decide finishes.
 */
export function requeueResults(a: Pick<FleetApprovalDto, 'decision' | 'resolvedBy' | 'outcome'>): RequeueResultView[] | null {
  if (a.decision !== 'raise_budget_and_resume' || a.resolvedBy !== 'user') return null
  const raw = a.outcome?.requeueResults
  if (!Array.isArray(raw)) return null
  return raw.flatMap((entry: unknown): RequeueResultView[] => {
    if (entry === null || typeof entry !== 'object') return []
    const row = entry as { jobId?: unknown; ok?: unknown; error?: unknown }
    if (!isString(row.jobId) || typeof row.ok !== 'boolean') return []
    return [{ jobId: row.jobId, ok: row.ok, reason: row.ok ? null : requeueFailure(row.error) }]
  })
}

export function resumedAmount(a: Pick<FleetApprovalDto, 'outcome'>): string | null {
  const value = a.outcome?.resumedAmountUsd
  if (isString(value)) return value
  return typeof value === 'number' ? String(value) : null
}

/** D248: policy id -> its pending budget approval id. */
export function pendingByPolicy(rows: readonly FleetApprovalDto[]): ReadonlyMap<string, string> {
  return new Map(
    rows
      .filter((r) => r.status === 'pending' && r.type === 'budget_override_required' && r.policyId !== null)
      .map((r): [string, string] => [r.policyId as string, r.id]),
  )
}

export function inboxPath(base: ApprovalBase, id?: string): string {
  const root = base.kind === 'admin' ? '/admin/fleet/approvals' : `/${base.slug}/fleet/approvals`
  return id === undefined ? root : `${root}?id=${encodeURIComponent(id)}`
}

/** D247: where the header badge leads. */
export function badgeTarget(counts: ApprovalCountsDto, ctx: { slug: string | null; globalAdmin: boolean }): string | null {
  if (ctx.slug) return inboxPath({ kind: 'project', slug: ctx.slug })
  if (ctx.globalAdmin) return inboxPath({ kind: 'admin' })
  const first = counts.projects[0]
  return first ? inboxPath({ kind: 'project', slug: first.slug }) : null
}

export const badgeText = (total: number): string => (total > BADGE_CAP ? `${BADGE_CAP}+` : String(total))

/** One-line row summary. `scopeLabel` names a budget scope (pages know their repo, runner and project names). */
export function approvalSummary(
  t: TranslateNamed,
  a: FleetApprovalDto,
  scopeLabel: (p: BudgetApprovalPayload) => string | null,
): string {
  const budget = budgetPayload(a)
  if (budget) {
    return t('fleet.approvals.summary.budget', {
      scope: scopeText(t, budget, scopeLabel(budget)),
      spent: formatUsd(budget.spentUsd),
      amount: formatUsd(budget.amountUsd),
    })
  }
  const bash = bashPayload(a)
  if (bash) return t('fleet.approvals.summary.bashCommand', { command: commandPreview(bash), stage: bash.stage })
  return a.type === 'nax_bash_escalate' ? t('fleet.approvals.summary.bash') : t('fleet.approvals.type.budget_override_required')
}

/** D243: the raise form's schema; messages are translated, `spent` is the spend recorded at the stop. */
export function buildRaiseSchema(t: TranslateNamed, spentUsd: string) {
  return z.object({
    amount: z.string().superRefine((value, ctx) => {
      const error = raiseAmountError(value, spentUsd)
      if (error !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t(`fleet.approvals.validation.${error}`, { spent: formatUsd(spentUsd) }) })
      }
    }),
    comment: z.string().refine((value) => !commentTooLong(value), t('fleet.approvals.validation.commentTooLong')),
  })
}
