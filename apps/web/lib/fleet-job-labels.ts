import { isConfigJob, reviewPrNumber } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

type Translate = (key: string) => string

/** The feature cell and page title of a job. */
export function jobFeatureLabel(job: FleetJobDto, t: Translate): string {
  if (isConfigJob(job)) return t('fleet.jobs.configFeature')

  if (job.command === 'THREAD') {
    return typeof job.threadTitle === 'string' && job.threadTitle.trim().length > 0
      ? job.threadTitle
      : t('fleet.jobs.threadFeature')
  }

  if (job.command === 'REVIEW' || job.command === 'FIX') {
    const prNumber = reviewPrNumber(job.feature)
    if (prNumber !== null) return `PR #${prNumber}`
  }

  return job.feature
}

/** The requester cell of a job: the API name, else the project member name, else "Former member". */
export function jobRequesterLabel(
  job: FleetJobDto,
  memberName: (id: string) => string | null,
  t: Translate,
): string {
  return job.requesterName ?? memberName(job.requestedById) ?? t('common.formerMember')
}
