import { apiPath } from '~/lib/api-path'
import type {
  IngestHealthDto, IngestQueuedDto, IngestRowDto, IngestStatus, JobAnalyticsDto, JobsAnalyticsDto, QualityAnalyticsDto,
  SpendAnalyticsDto, StoriesAnalyticsDto,
} from '~/lib/fleet-analytics-types'
import type { FleetPage } from '~/lib/fleet-types'

/** The window the API gets (see lib/fleet-analytics-range.ts rangeWindow). */
export interface WindowQuery {
  from: string
  to: string
}

/** D390: 7 named series plus `other` fill the 8-color palette. */
export const SPEND_TOP = 7
/** Rows per top table on the Analytics page. */
export const ANALYTICS_TABLE_LIMIT = 10
export const INGEST_PAGE_SIZE = 20

const topQuery = (top: number | undefined): Record<string, string> => (top === undefined ? {} : { top: String(top) })

/** Fleet S2b §4.2 project routes (any project member). */
export function useFleetAnalytics(slug: string) {
  const { $api } = useApi()
  return {
    spend: (w: WindowQuery, groupBy: string, top?: number) =>
      $api.get<SpendAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/spend`, { query: { ...w, groupBy, ...topQuery(top) } }),
    quality: (w: WindowQuery) => $api.get<QualityAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/quality`, { query: { ...w } }),
    stories: (w: WindowQuery, sort: 'cost' | 'attempts', limit: number) =>
      $api.get<StoriesAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/stories`, { query: { ...w, sort, limit: String(limit) } }),
    jobs: (w: WindowQuery, limit: number) =>
      $api.get<JobsAnalyticsDto>(apiPath`/projects/${slug}/fleet/analytics/jobs`, { query: { ...w, sort: 'cost', limit: String(limit) } }),
    ingest: (w: WindowQuery) => $api.get<IngestHealthDto>(apiPath`/projects/${slug}/fleet/analytics/ingest`, { query: { ...w } }),
    job: (jobId: string) => $api.get<JobAnalyticsDto>(apiPath`/projects/${slug}/fleet/jobs/${jobId}/analytics`),
  }
}

/** Fleet S2b §4.3 admin routes (global ADMIN; anything else answers 403). */
export function useFleetAnalyticsAdmin() {
  const { $api } = useApi()
  return {
    spend: (w: WindowQuery, groupBy: string, top?: number) =>
      $api.get<SpendAnalyticsDto>('/fleet/analytics/spend', { query: { ...w, groupBy, ...topQuery(top) } }),
    ingestList: (status: IngestStatus | undefined, page: number) =>
      $api.get<FleetPage<IngestRowDto>>('/fleet/ingest', {
        query: { size: String(INGEST_PAGE_SIZE), ...(status ? { status } : {}), ...(page > 1 ? { current: String(page) } : {}) },
      }),
    backfill: () => $api.post<IngestQueuedDto>('/fleet/ingest/backfill'),
    rerun: (jobId: string) => $api.post<IngestQueuedDto>(apiPath`/fleet/ingest/jobs/${jobId}/rerun`),
    rerunOutdated: () => $api.post<IngestQueuedDto>('/fleet/ingest/rerun-outdated'),
  }
}
