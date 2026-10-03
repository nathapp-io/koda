import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { buildApprovalQuery, INBOX_PENDING_SIZE, sortPending } from '~/lib/fleet-approvals'
import type { ApprovalBase, ApprovalListFilters } from '~/lib/fleet-approvals'
import type { ApprovalCountsDto, DecideApprovalBody, FleetApprovalDto, FleetPage } from '~/lib/fleet-types'

export const approvalRoot = (base: ApprovalBase): string =>
  base.kind === 'admin' ? '/fleet/approvals' : apiPath`/projects/${base.slug}/fleet/approvals`

export const approvalItem = (base: ApprovalBase, id: string): string =>
  base.kind === 'admin' ? apiPath`/fleet/approvals/${id}` : apiPath`/projects/${base.slug}/fleet/approvals/${id}`

/** D249 (D224 pattern): a load that started before a successful decide is dropped. */
let mutationEpoch = 0

/** D247: bumped after every successful decide; the header badge refreshes on it (the admin inbox has no live channel). */
export const approvalsVersion = ref(0)

/** Approvals of one base: one list page and the decide. */
export function useFleetApprovals(base: ApprovalBase) {
  const { $api } = useApi()
  const approvals = ref<FleetApprovalDto[]>([])
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)
  let latestLoadId = 0

  async function load(filters: ApprovalListFilters): Promise<boolean> {
    const loadId = ++latestLoadId
    const epoch = mutationEpoch
    const res = await $api.get<FleetPage<FleetApprovalDto>>(approvalRoot(base), { query: buildApprovalQuery(filters) })
    if (loadId !== latestLoadId || epoch !== mutationEpoch) return false
    const rows = res.records ?? []
    approvals.value = filters.tab === 'pending' ? sortPending(rows) : rows
    total.value = res.total ?? 0
    page.value = res.current ?? 1
    hasNext.value = res.hasNext === true
    return true
  }

  const get = (id: string): Promise<FleetApprovalDto> => $api.get<FleetApprovalDto>(approvalItem(base, id))

  async function decide(id: string, body: DecideApprovalBody): Promise<FleetApprovalDto> {
    const decided = await $api.post<FleetApprovalDto>(`${approvalItem(base, id)}/decide`, { ...body })
    mutationEpoch += 1
    approvalsVersion.value += 1
    approvals.value = approvals.value.map((a) => (a.id === decided.id ? decided : a))
    return decided
  }

  /** D297: every approval of one job (job page), newest first, one page of 100. */
  async function listForJob(jobId: string): Promise<FleetApprovalDto[]> {
    const res = await $api.get<FleetPage<FleetApprovalDto>>(approvalRoot(base), { query: { jobId, size: String(INBOX_PENDING_SIZE) } })
    return res.records ?? []
  }

  return { approvals, total, page, hasNext, load, get, decide, listForJob }
}

export type FleetApprovalsApi = ReturnType<typeof useFleetApprovals>

/** Spec §2.3 `GET /fleet/approval-counts`: over the caller's memberships (plus unscoped for a global ADMIN). */
export function useFleetApprovalCounts() {
  const { $api } = useApi()
  const counts = ref<ApprovalCountsDto | null>(null)
  let latestLoadId = 0

  async function load(): Promise<void> {
    const loadId = ++latestLoadId
    const res = await $api.get<ApprovalCountsDto>('/fleet/approval-counts')
    if (loadId === latestLoadId) counts.value = res
  }

  return { counts, load }
}
