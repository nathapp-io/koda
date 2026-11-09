import { apiPath } from '~/lib/api-path'
import { isPendingFlowAnswer } from '~/lib/fleet-flows'
import type { FleetFlowDto, FleetFlowOverviewDto, FleetFlowPage } from '~/lib/fleet-flows'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'

export type FlowWrite =
  | { kind: 'done'; flow: FleetFlowDto }
  | { kind: 'pending'; request: ApprovalRequestSummary }

export function useFleetFlows(slug: string) {
  const { $api } = useApi()
  const root = apiPath`/projects/${slug}/flows`
  const item = (flowId: string): string => `${root}/${encodeURIComponent(flowId)}`

  const list = (page: number, threadId?: string): Promise<FleetFlowPage> => {
    const query = `?current=${encodeURIComponent(String(page))}&size=20${threadId === undefined ? '' : `&threadId=${encodeURIComponent(threadId)}`}`
    return $api.get<FleetFlowPage>(`${root}${query}`)
  }

  const get = (flowId: string): Promise<FleetFlowDto> => $api.get<FleetFlowDto>(item(flowId))
  const overview = (flowId: string): Promise<FleetFlowOverviewDto> => $api.get<FleetFlowOverviewDto>(`${item(flowId)}/overview`)

  async function write(request: Promise<FleetFlowDto | ApprovalRequestSummary>): Promise<FlowWrite> {
    const data = await request
    return isPendingFlowAnswer(data) ? { kind: 'pending', request: data } : { kind: 'done', flow: data }
  }

  const stop = (flowId: string): Promise<FlowWrite> => write($api.post<FleetFlowDto | ApprovalRequestSummary>(`${item(flowId)}/stop`))
  const answer = (flowId: string, jobId: string, answers: { id: string; answer: string }[]): Promise<FlowWrite> =>
    write($api.post<FleetFlowDto | ApprovalRequestSummary>(`${item(flowId)}/answers`, { jobId, answers }))

  return { list, get, overview, stop, answer }
}
