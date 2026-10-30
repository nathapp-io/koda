import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { DETAIL_FETCH_LIMIT, buildRequestQuery, sortPendingRequests } from '~/lib/approval-requests'
import type {
  ApprovalRequestCounts, ApprovalRequestDetail, ApprovalRequestPage, ApprovalRequestSummary,
  DecideRequestBody, RequestListFilters,
} from '~/lib/approval-requests'

/**
 * P3b US-001: the approval engine's client (`GET/POST /approvals`).
 *
 * It is the one client every approvals surface reads:
 * - the inbox lists a page and fetches one row's detail when it opens;
 * - the job page and the budget banner read `listForJob` / `listDetailed`, because the list answer
 *   carries no `input` and no `details` (the two fields they need);
 * - the header badge reads `counts`;
 * - the panels decide and cancel.
 *
 * The rules it does not carry: who may decide a row is `viewerActions` (the row decides, not the
 * caller's keys), and what a fleet request's payload means lives in the fleet helpers.
 */

/** One job's request plus the detail of the open row (`null` when it was not fetched or failed). */
export interface JobApprovalRow {
  request: ApprovalRequestSummary
  detail: ApprovalRequestDetail | null
}

/** One page of one job's requests (job pages show a job, not the inbox pager). */
const JOB_LIST_SIZE = 100

/**
 * Bumped after every successful decide or cancel: the header badge and anything else counting
 * pending requests reload on it instead of polling twice (the admin inbox has no live channel).
 */
export const approvalRequestsVersion = ref(0)

const requestPath = (id: string): string => apiPath`/approvals/${id}`

/**
 * The decision body the engine takes: the comment is trimmed and dropped when blank, and `params`
 * travels only when the caller sent one. Built as a fresh object so the caller's body is never
 * mutated and never leaks an `undefined` field onto the wire.
 */
function postedDecision(body: DecideRequestBody): Record<string, unknown> {
  const comment = (body.comment ?? '').trim()
  return {
    decision: body.decision,
    ...(comment === '' ? {} : { comment }),
    ...(body.params === undefined ? {} : { params: body.params }),
  }
}

/** The pager of one list answer, with a default for every field the API always sends. */
function toPage(answer: Partial<ApprovalRequestPage> | null | undefined): ApprovalRequestPage {
  return {
    total: answer?.total ?? 0,
    current: answer?.current ?? 1,
    size: answer?.size ?? 0,
    hasNext: answer?.hasNext === true,
    hasPrev: answer?.hasPrev === true,
    records: answer?.records ?? [],
  }
}

/** Pending rows first (soonest expiry), then everything else newest first. */
function orderForJob(records: readonly ApprovalRequestSummary[]): ApprovalRequestSummary[] {
  const pending = sortPendingRequests(records.filter((row) => row.status === 'pending'))
  const rest = records
    .filter((row) => row.status !== 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  return [...pending, ...rest]
}

export function useApprovalInbox() {
  const { $api } = useApi()
  const requests = ref<ApprovalRequestSummary[]>([])
  const total = ref(0)
  const page = ref(1)
  const size = ref(0)
  const hasNext = ref(false)
  const hasPrev = ref(false)
  const requestCounts = ref<ApprovalRequestCounts | null>(null)
  let latestCountsId = 0

  /** The last list answer, kept in the refs beside it so a page can render the inbox from either. */
  async function list(filters: RequestListFilters): Promise<ApprovalRequestPage> {
    const answer = toPage(await $api.get<Partial<ApprovalRequestPage>>('/approvals', { query: buildRequestQuery(filters) }))
    requests.value = answer.records
    total.value = answer.total
    page.value = answer.current
    size.value = answer.size
    hasNext.value = answer.hasNext
    hasPrev.value = answer.hasPrev
    return answer
  }

  const get = (id: string): Promise<ApprovalRequestDetail> => $api.get<ApprovalRequestDetail>(requestPath(id))

  /**
   * Each row of `rows` with the detail of its first `limit` rows attached. A row past the limit, or
   * one whose detail fetch fails, keeps `detail: null` and renders from its summary fields (the key
   * label) — one failing row must not take the others with it.
   */
  async function withDetails(rows: readonly ApprovalRequestSummary[], limit: number): Promise<JobApprovalRow[]> {
    const detailed = rows.slice(0, Math.max(0, Math.trunc(limit)))
    const details = await Promise.all(detailed.map(async (request) => {
      try {
        return await get(request.id)
      }
      catch {
        // Intentional: a failed detail is one row without a preview, not a failed surface.
        return null
      }
    }))
    return rows.map((request, index) => ({
      request,
      detail: index < detailed.length ? details[index] : null,
    }))
  }

  /** A page of the inbox, every listed row detailed up to `limit` (the two surfaces that need it). */
  async function listDetailed(
    filters: RequestListFilters,
    limit: number = DETAIL_FETCH_LIMIT,
  ): Promise<JobApprovalRow[]> {
    const answer = await list(filters)
    return withDetails(answer.records, limit)
  }

  /**
   * Every request of one job, in one page of 100: pending first by soonest expiry (they are what the
   * job page calls out), then the settled ones newest first.
   */
  async function listForJob(jobId: string): Promise<JobApprovalRow[]> {
    const answer = toPage(await $api.get<Partial<ApprovalRequestPage>>('/approvals', {
      query: { jobId, size: String(JOB_LIST_SIZE) },
    }))
    return withDetails(orderForJob(answer.records), DETAIL_FETCH_LIMIT)
  }

  /** `GET /approvals/counts`: every visible pending request. A stale answer is not stored. */
  async function counts(): Promise<ApprovalRequestCounts> {
    const id = ++latestCountsId
    const answer = await $api.get<ApprovalRequestCounts>('/approvals/counts')
    if (id === latestCountsId) requestCounts.value = answer
    return answer
  }

  async function decide(id: string, body: DecideRequestBody): Promise<ApprovalRequestDetail> {
    const decided = await $api.post<ApprovalRequestDetail>(`${requestPath(id)}/decisions`, postedDecision(body))
    approvalRequestsVersion.value += 1
    return decided
  }

  async function cancel(id: string): Promise<ApprovalRequestDetail> {
    const cancelled = await $api.post<ApprovalRequestDetail>(`${requestPath(id)}/cancel`)
    approvalRequestsVersion.value += 1
    return cancelled
  }

  return {
    requests, total, page, size, hasNext, hasPrev, requestCounts, approvalRequestsVersion,
    list, listDetailed, listForJob, get, counts, decide, cancel,
  }
}
