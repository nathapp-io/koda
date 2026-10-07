import type { ConfigEditPayload, ConfigFileEdit } from '@nathapp/fleet-protocol'
import { apiPath } from '~/lib/api-path'
import { CONFIG_JOB_FEATURE, pickActiveJob } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto, FleetPage } from '~/lib/fleet-types'
import type { NaxFileContent, NaxFileList } from '~/lib/nax-config'

export interface ConfigEditBody { baseSha: string; edits: ConfigFileEdit[]; prTitle: string; prBody?: string }
export interface ConfigPrBody { prTitle: string; prBody?: string }

/** An empty description is not sent (the API stores null). */
const withBody = <T extends { prBody?: string }>(body: T): T => {
  const { prBody, ...rest } = body
  return (prBody && prBody.length > 0 ? { ...rest, prBody } : rest) as T
}

/** S3 §4: the config page's and the config job panel's calls; no page state lives here. */
export function useFleetRepoConfig(slug: string) {
  const { $api } = useApi()
  const repoBase = (repoId: string): string => apiPath`/projects/${slug}/fleet/repos/${repoId}`

  const list = (repoId: string): Promise<NaxFileList> => $api.get<NaxFileList>(`${repoBase(repoId)}/nax-files`)

  const read = (repoId: string, path: string, ref: string): Promise<NaxFileContent> =>
    $api.get<NaxFileContent>(`${repoBase(repoId)}/nax-files/content`, { query: { path, ref } })

  // S3 §4.2 (B1): the three submits answer like dispatch, `{ job, placement }`.
  // The body is spread because $api.post takes Record<string, unknown> and the
  // body interfaces have no index signature (same as useFleetJobs' dispatch).
  const submitEdit = (repoId: string, body: ConfigEditBody): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(`${repoBase(repoId)}/config-edits`, { ...withBody(body) })

  const submitRegenerate = (repoId: string, body: ConfigPrBody): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(`${repoBase(repoId)}/config-edits/regenerate`, { ...withBody(body) })

  const submitDrift = (repoId: string): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(`${repoBase(repoId)}/drift-checks`, {})

  const jobEdits = (jobId: string): Promise<ConfigEditPayload> =>
    $api.get<ConfigEditPayload>(apiPath`/projects/${slug}/fleet/jobs/${jobId}/config-edit`)

  /** S3 §4.2: the job behind a 409 `config_job_active` (D465: one active config job per repo). */
  async function activeConfigJob(repoId: string): Promise<FleetJobDto | null> {
    const res = await $api.get<FleetPage<FleetJobDto>>(apiPath`/projects/${slug}/fleet/jobs`, {
      query: { repoId, feature: CONFIG_JOB_FEATURE, size: '20' },
    })
    return pickActiveJob(res.records ?? [])
  }

  return { list, read, submitEdit, submitRegenerate, submitDrift, jobEdits, activeConfigJob }
}
