import { apiPath } from '~/lib/api-path'
import type { FleetJobLogEntriesDto, FleetJobLogListDto, LogStream } from '~/lib/fleet-log-types'

/** Fleet S2a §3: the log read routes of one job. Every call goes through useApi; nothing here holds page state. */
export function useFleetJobLogs(slug: string, jobId: string) {
  const { $api } = useApi()
  const config = useRuntimeConfig()
  const base = apiPath`/projects/${slug}/fleet/jobs/${jobId}/logs`

  const list = (): Promise<FleetJobLogListDto> => $api.get<FleetJobLogListDto>(base)

  const entries = (stream: LogStream, query: Record<string, string>): Promise<FleetJobLogEntriesDto> =>
    $api.get<FleetJobLogEntriesDto>(`${base}${apiPath`/${stream}/entries`}`, { query })

  /** Spec §4.1: a plain anchor through the Nuxt /api proxy, which streams; never $api.download (it buffers a Blob). */
  const downloadHref = (stream: LogStream, leaseEpoch: number): string =>
    `${String(config.public.apiBaseUrl)}${base}${apiPath`/${stream}/raw`}?download=1&leaseEpoch=${leaseEpoch}`

  return { list, entries, downloadHref }
}
