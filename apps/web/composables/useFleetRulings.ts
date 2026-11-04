import { apiPath } from '~/lib/api-path'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'
import type { FleetPrRulingDto } from '~/lib/fleet-types'

export interface CreateRulingDto {
  itemId: string
  text: string
}
export type CreateRulingResult = FleetPrRulingDto | ApprovalRequestSummary

/** useApi owns envelope unwrapping, including successful 202 approval summaries. */
export function useFleetRulings(slug: string) {
  const { $api } = useApi()
  const path = (jobId: string) => apiPath`/projects/${slug}/fleet/jobs/${jobId}/rulings`
  const list = (jobId: string): Promise<FleetPrRulingDto[]> => $api.get<FleetPrRulingDto[]>(path(jobId))
  const create = (jobId: string, body: CreateRulingDto): Promise<CreateRulingResult> =>
    $api.post<CreateRulingResult>(path(jobId), { ...body })
  return { list, create }
}
