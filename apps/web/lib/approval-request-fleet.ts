/**
 * P3b US-004: the fleet half of the approval engine's decide panel.
 *
 * The engine inbox renders one request per key, and the two fleet keys carry a payload the generic
 * form cannot word: a bash ask offers nax's own choices, and a budget stop asks for a raised limit
 * and the cancelled jobs to put back in the queue. The pure rules live here, so the panel stays a
 * template and every body the engine receives is testable without mounting anything.
 *
 * Nothing about the fleet payload is re-implemented: `bashPayload`, `budgetPayload`, `deliveryView`,
 * `requeueFailure` and `raiseAmountError` in `lib/fleet-approvals.ts` already parse and explain those
 * shapes, and the panels read the same answers they did on the retired fleet inbox.
 */
import * as z from 'zod'
import { buildCommentSchema } from '~/lib/approval-requests'
import type { ApprovalRequestDetail, DecideRequestBody } from '~/lib/approval-requests'
import { parseAmount } from '~/lib/fleet-budgets'
import type { TranslateNamed } from '~/lib/fleet-budgets'
import { bashPayload, budgetPayload, deliveryView, raiseAmountError, requeueFailure } from '~/lib/fleet-approvals'
import type {
  BashApprovalPayload, BashDecision, BudgetApprovalPayload, DeliveryView, RequeueFailure,
} from '~/lib/fleet-approvals'
import { APPROVAL_RESOLVED_BY } from '~/lib/fleet-types'
import type { ApprovalResolvedBy } from '~/lib/fleet-types'
import { formatUsd } from '~/lib/fleet-jobs'

/** The two permission keys the fleet adapters own (apps/api `src/fleet/approvals/commands/`). */
export const BASH_APPROVAL_KEY = 'fleet.job.shell.escalate'
export const BUDGET_APPROVAL_KEY = 'fleet.budget.override'

export type RequestPanelKind = 'bash' | 'budget' | 'generic'

/** Which decide surface a request needs: its key says what its frozen input means. */
export function requestPanelKind(request: Pick<ApprovalRequestDetail, 'permissionKey'>): RequestPanelKind {
  if (request.permissionKey === BASH_APPROVAL_KEY) return 'bash'
  if (request.permissionKey === BUDGET_APPROVAL_KEY) return 'budget'
  return 'generic'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/** `details` is an open record on the wire; every reader below narrows its own field. */
const detailsOf = (request: Pick<ApprovalRequestDetail, 'details'>): Record<string, unknown> | null =>
  isRecord(request.details) ? request.details : null

const resolvedByOf = (details: Record<string, unknown> | null): ApprovalResolvedBy | null => {
  const value = details?.resolvedBy
  if (!isString(value)) return null
  return (APPROVAL_RESOLVED_BY as readonly string[]).includes(value) ? (value as ApprovalResolvedBy) : null
}

const outcomeOf = (details: Record<string, unknown> | null): Record<string, unknown> | null =>
  details !== null && isRecord(details.outcome) ? details.outcome : null

/** The bash ask the request froze: the input nax sent, plus the job id its details name. */
export interface BashAsk {
  jobId: string | null
  leaseEpoch: number | null
  naxAskId: string | null
  /** Null when the frozen payload is not one `bashPayload` accepts: the ask then reads deny-only. */
  payload: BashApprovalPayload | null
}

/**
 * The bash ask of a `fleet.job.shell.escalate` request, or null for any other key.
 *
 * The job id comes from `details` first (that is what the runner answered), falling back to the
 * frozen input, so a request whose details are unavailable still names the job the ask belongs to.
 */
export function bashAskOf(
  request: Pick<ApprovalRequestDetail, 'permissionKey' | 'input' | 'details'>,
): BashAsk | null {
  if (requestPanelKind(request) !== 'bash') return null
  const input = isRecord(request.input) ? request.input : null
  const rawPayload = input === null ? undefined : input.payload
  return {
    jobId: stringField(detailsOf(request), 'jobId') ?? stringField(input, 'jobId'),
    leaseEpoch: typeof input?.leaseEpoch === 'number' ? input.leaseEpoch : null,
    naxAskId: stringField(input, 'naxAskId'),
    payload: isRecord(rawPayload) ? bashPayload({ type: 'nax_bash_escalate', payload: rawPayload }) : null,
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return isString(value) ? value : null
}

/** The budget stop the request froze, plus the policy its details name. */
export interface BudgetAsk extends BudgetApprovalPayload {
  policyId: string | null
  requestedAt: string | null
}

/** The budget ask of a `fleet.budget.override` request, or null when the key or the input is not one. */
export function budgetAskOf(
  request: Pick<ApprovalRequestDetail, 'permissionKey' | 'input' | 'details'>,
): BudgetAsk | null {
  if (requestPanelKind(request) !== 'budget') return null
  const input = isRecord(request.input) ? request.input : null
  if (input === null) return null
  const payload = budgetPayload({ type: 'budget_override_required', payload: input })
  if (payload === null) return null
  return {
    ...payload,
    policyId: stringField(detailsOf(request), 'policyId') ?? stringField(input, 'policyId'),
    requestedAt: stringField(input, 'requestedAt'),
  }
}

export interface RequeueCandidateView {
  jobId: string
  projectId: string
  feature: string
  queuedAt: string
}

export interface RequeueOfferView {
  candidates: RequeueCandidateView[]
  /** More cancelled jobs exist than the engine listed, so only the listed ones can be re-queued. */
  truncated: boolean
}

const NOT_OFFERED: RequeueOfferView = { candidates: [], truncated: false }

/**
 * The cancelled jobs a pending budget stop offers to re-queue. The engine sends them only while the
 * request is pending, and a row without the four strings is dropped rather than rendered half-empty.
 */
export function requeueCandidatesOf(
  request: Pick<ApprovalRequestDetail, 'permissionKey' | 'details'>,
): RequeueOfferView {
  const details = detailsOf(request)
  if (requestPanelKind(request) !== 'budget' || details === null) return NOT_OFFERED
  const raw = Array.isArray(details.requeueCandidates) ? details.requeueCandidates : []
  return {
    candidates: raw.flatMap((entry: unknown): RequeueCandidateView[] => {
      if (!isRecord(entry)) return []
      const { jobId, projectId, feature, queuedAt } = entry
      if (!isString(jobId) || !isString(projectId) || !isString(feature) || !isString(queuedAt)) return []
      return [{ jobId, projectId, feature, queuedAt }]
    }),
    truncated: details.requeueCandidatesTruncated === true,
  }
}

/** A comment travels only when it says something, and always trimmed: the engine validates that text. */
const commentField = (comment: string): { comment?: string } => {
  const trimmed = comment.trim()
  return trimmed === '' ? {} : { comment: trimmed }
}

/**
 * The bash decide body each choice means (apps/api `FleetShellEscalateCommand.parseDecision`):
 * allow and allow-for-this-job approve with their choice, deny rejects with `deny`.
 */
export function bashRequestBody(choice: BashDecision, comment: string): DecideRequestBody {
  return {
    decision: choice === 'deny' ? 'reject' : 'approve',
    params: { choice },
    ...commentField(comment),
  }
}

/**
 * The raise body (`FleetBudgetOverrideCommand.parseDecision`): the parsed limit and the ticked job
 * ids. `requeueJobIds` is always sent, `[]` included — omitted also reads as "none", but an empty
 * list is what the decider actually chose.
 */
export function budgetRaiseBody(
  input: { amount: string; requeueJobIds: readonly string[]; comment: string },
): DecideRequestBody {
  const amountUsd = parseAmount(input.amount.trim())
  if (amountUsd === null) throw new Error('approval-request-fleet: amount was not validated')
  return {
    decision: 'approve',
    params: { amountUsd, requeueJobIds: [...input.requeueJobIds] },
    ...commentField(input.comment),
  }
}

/** Keeping the policy paused is a bare rejection: `parseDecision` refuses any params on a reject. */
export function budgetKeepBody(comment: string): DecideRequestBody {
  return { decision: 'reject', ...commentField(comment) }
}

/**
 * The raise form's schema. The amount must parse and sit above the spend frozen at the stop (the
 * server re-checks the live spend); the comment is the engine's own rule, not a second copy of it.
 */
export function buildBudgetRaiseSchema(t: TranslateNamed, spentUsd: string) {
  return z.object({
    amount: z.string().superRefine((value, ctx) => {
      const error = raiseAmountError(value, spentUsd)
      if (error !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t(`approvals.fleet.budget.validation.${error}`, { spent: formatUsd(spentUsd) }),
        })
      }
    }),
    comment: buildCommentSchema(t).shape.comment,
  })
}

/** The runner's ack of a bash answer, for a request a user decided; null where nothing was sent. */
export function requestDelivery(
  request: Pick<ApprovalRequestDetail, 'permissionKey' | 'details'>,
): DeliveryView | null {
  if (requestPanelKind(request) !== 'bash') return null
  const details = detailsOf(request)
  if (details === null) return null
  return deliveryView({
    type: 'nax_bash_escalate',
    resolvedBy: resolvedByOf(details),
    outcome: outcomeOf(details),
  })
}

/** Who settled the request: a human, a timeout, a job that ended first, or a superseded stop. */
export function requestResolvedBy(
  request: Pick<ApprovalRequestDetail, 'details'>,
): ApprovalResolvedBy | null {
  return resolvedByOf(detailsOf(request))
}

export interface RequestRequeueResultView {
  jobId: string
  ok: boolean
  reason: RequeueFailure | null
}

/**
 * The re-queue records of a budget raise. Null when the request carries none at all — a keep-paused
 * decision never offered a re-queue, and saying "none selected" there would be a guess. The raised
 * amount is deliberately not read here: the outcome shows the re-queue results only.
 */
export function requestRequeueResults(
  request: Pick<ApprovalRequestDetail, 'permissionKey' | 'details'>,
): RequestRequeueResultView[] | null {
  if (requestPanelKind(request) !== 'budget') return null
  const raw = outcomeOf(detailsOf(request))?.requeueResults
  if (!Array.isArray(raw)) return null
  return raw.flatMap((entry: unknown): RequestRequeueResultView[] => {
    if (!isRecord(entry)) return []
    const { jobId, ok, error } = entry
    if (!isString(jobId) || typeof ok !== 'boolean') return []
    return [{ jobId, ok, reason: ok ? null : requeueFailure(error) }]
  })
}
