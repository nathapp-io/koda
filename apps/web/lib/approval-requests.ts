/**
 * P3b US-001: the web's client for the approval engine (`/approvals`).
 *
 * The engine is the one inbox every gated route reports into — a fleet bash ask, a budget stop and
 * any other permission key alike. This module is its pure half: the DTO shapes the API answers, the
 * list query, the row ordering, the per-row control rules and the i18n helpers. The request wiring
 * lives in `composables/useApprovalInbox.ts`, so every rule here is testable without a component.
 *
 * Two things are deliberately decided here rather than from the caller's permission keys:
 *
 * - **Who sees which control comes from the row.** `GET /approvals` already answers only what the
 *   caller may see, and the API re-checks `approval.decide` per request (pattern, whether the
 *   approver must hold the action, self mode). A browser cannot repeat that check, so
 *   `viewerActions` reads the request itself.
 * - **Pending requests are one page of 100.** The inbox shows what needs a decision now; the All
 *   tab is the browsable history and pages by 20. That keeps the badge, the Pending tab and the
 *   home card on one number.
 */
import * as z from 'zod'
import type { TranslateNamed } from '~/lib/fleet-budgets'

/** vue-i18n's `te`: does this locale know the key? */
export type TranslationExists = (key: string) => boolean

/** apps/api `APPROVAL_REQUEST_STATUSES` (list-approval-requests.query.ts). */
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'failed'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/** apps/api `DecideApprovalRequestDto.decision`. */
export const REQUEST_DECISIONS = ['approve', 'reject'] as const
export type RequestDecision = (typeof REQUEST_DECISIONS)[number]

export type ActorKind = 'USER' | 'AGENT' | 'SYSTEM'

/** Modes rank `none < self < agent < human` (approval-policy.validation.ts). */
export type ApprovalMode = 'none' | 'self' | 'agent' | 'human'

/**
 * `ApprovalRequestSummaryDto`: one listed request. The list carries no `input`, `jobId` or
 * `details` — a surface that needs a field from those fetches `GET /approvals/:id` for the row.
 */
export interface ApprovalRequestSummary {
  id: string
  permissionKey: string
  projectId: string | null
  actorType: ActorKind
  actorId: string
  onBehalfOfType: ActorKind | null
  onBehalfOfId: string | null
  origin: string
  redeem: boolean
  requiredMode: ApprovalMode
  status: RequestStatus
  satisfiedBy: ApprovalMode | null
  approverType: ActorKind | null
  approverId: string | null
  /** Always set by the API; nullable here so a settled or hand-made row cannot break a countdown. */
  expiresAt: string | null
  decidedAt: string | null
  settledAt: string | null
  createdAt: string
}

/** One row of `ApprovalRequestDto.decisions`. */
export interface ApprovalDecisionRecord {
  id: string
  deciderType: ActorKind
  deciderId: string
  decision: RequestDecision
  comment: string | null
  params: unknown
  decidedAt: string
}

/** `ApprovalRequestDto`: the summary plus what only the open row needs. */
export interface ApprovalRequestDetail extends ApprovalRequestSummary {
  input: unknown
  result: unknown
  details: Record<string, unknown> | null
  decisions: ApprovalDecisionRecord[]
}

export interface ApprovalProjectCount {
  projectId: string
  slug: string
  pending: number
}

/** `GET /approvals/counts`: every visible pending request, the caller's own included. */
export interface ApprovalRequestCounts {
  total: number
  unscoped: number
  projects: ApprovalProjectCount[]
}

/** `POST /approvals/:id/decisions`. `params` is the fleet choice, when the action asks for one. */
export interface DecideRequestBody {
  decision: RequestDecision
  comment?: string
  params?: Record<string, unknown>
}

/** One row of a list answer, kept whole so a caller never loses the pager metadata. */
export interface ApprovalRequestPage {
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
  records: ApprovalRequestSummary[]
}

/** The inbox's two tabs: what needs a decision, and everything else. */
export const REQUEST_TABS = ['pending', 'all'] as const
export type RequestTab = (typeof REQUEST_TABS)[number]

/** D240's sizes, on the engine list: the Pending tab is one page, the All tab pages by 20. */
const PENDING_SIZE = 100
const PAGE_SIZE = 20

/** How many rows of a list get their detail fetched (`listDetailed`, `listForJob`). */
export const DETAIL_FETCH_LIMIT = 20

/** apps/api `DecideApprovalRequestDto.comment` MaxLength. */
export const MAX_REQUEST_COMMENT = 2000

export interface RequestListFilters {
  tab?: RequestTab
  status?: RequestStatus
  projectId?: string
  permissionKey?: string
  jobId?: string
  mine?: boolean
  /** The All tab's page; page 1 is the server default and sends no `current`. */
  page?: number
}

/**
 * The list query for one filter set. Only set filters reach the wire, and `current` only past page 1.
 * A pending-only filter (the tab, or a bare `status: 'pending'` from a surface that wants one page of
 * pending rows) is one page of 100; anything else pages by 20.
 */
export function buildRequestQuery(f: RequestListFilters): Record<string, string> {
  const status = f.status ?? (f.tab === 'pending' ? 'pending' : undefined)
  return {
    ...(status === undefined ? {} : { status }),
    ...(f.projectId === undefined ? {} : { projectId: f.projectId }),
    ...(f.permissionKey === undefined ? {} : { permissionKey: f.permissionKey }),
    ...(f.jobId === undefined ? {} : { jobId: f.jobId }),
    ...(f.mine === undefined ? {} : { mine: String(f.mine) }),
    size: String(status === 'pending' ? PENDING_SIZE : PAGE_SIZE),
    ...(f.tab === 'all' && f.page !== undefined && f.page > 1 ? { current: String(f.page) } : {}),
  }
}

/** What an ordering helper needs from a row. */
export type ExpiringRow = Pick<ApprovalRequestSummary, 'id' | 'expiresAt'>

/**
 * Soonest `expiresAt` first — ISO instants compare as strings. Rows without an expiry keep their
 * given order after the dated ones, and equal expiries break on id so the order is stable.
 */
export function sortPendingRequests<T extends ExpiringRow>(rows: readonly T[]): T[] {
  const dated = rows
    .filter((row) => row.expiresAt !== null)
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') || a.id.localeCompare(b.id))
  return [...dated, ...rows.filter((row) => row.expiresAt === null)]
}

export interface ViewerActions {
  decide: boolean
  cancel: boolean
}

/**
 * What one viewer may do with one listed request.
 *
 * - A settled request (`status !== 'pending'`) shows neither control.
 * - The caller is the **requester** when the request is a user's and that user is the caller. An own
 *   pending request is cancellable, and shows the decide controls only in `self` mode — the engine's
 *   `self` mode means "the asker decides it", which is the one case a requester may approve.
 * - Every other pending request shows the decide controls and no Cancel. That includes a request
 *   raised on the caller's behalf: the API may still refuse it, and the refusal toasts.
 */
export function viewerActions(
  request: Pick<ApprovalRequestSummary, 'status' | 'actorType' | 'actorId' | 'requiredMode'>,
  userId: string | null,
): ViewerActions {
  if (request.status !== 'pending') return { decide: false, cancel: false }
  const requester = request.actorType === 'USER' && userId !== null && request.actorId === userId
  if (requester) return { decide: request.requiredMode === 'self', cancel: true }
  return { decide: true, cancel: false }
}

/** The inbox a request belongs to: its project's, or the global one when it has no project. */
export function inboxHref(slug: string | null, id?: string): string {
  const path = slug === null ? '/approvals' : `/${encodeURIComponent(slug)}/approvals`
  return id === undefined ? path : `${path}?id=${encodeURIComponent(id)}`
}

/**
 * The label of a permission key: `approvals.keys.<key with '.' replaced by '_'>` when the locale
 * knows it, else the key itself. Only keys the UI has words for get a label; every other one reads
 * as its own self-explanatory name.
 */
export function requestKeyLabel(t: TranslateNamed, te: TranslationExists, key: string): string {
  const i18nKey = `approvals.keys.${key.replace(/\./g, '_')}`
  return te(i18nKey) ? t(i18nKey) : key
}

/**
 * The decide form's comment schema (`web.md`: schema-backed forms). The cap is the engine DTO's, and
 * it is counted on the trimmed text — which is the text the body actually carries.
 */
export function buildCommentSchema(t: TranslateNamed) {
  return z.object({
    comment: z.string().superRefine((value, ctx) => {
      if (value.trim().length > MAX_REQUEST_COMMENT) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('approvals.comment.tooLong') })
      }
    }),
  })
}
