import type { FleetJobDto } from '~/lib/fleet-types'

/** UI eligibility only: the API rechecks provider, repo attribution and latest RUN. */
export function draftRunPrNumber(job: FleetJobDto): number | null {
  if (job.command !== 'RUN' || job.workflow?.outcome !== 'draft' || !job.resultPrUrl) return null
  try {
    const url = new URL(job.resultPrUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null
    const match = /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
    const pr = match ? Number(match[1]) : NaN
    return Number.isSafeInteger(pr) ? pr : null
  }
  catch {
    return null
  }
}
