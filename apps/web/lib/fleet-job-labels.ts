import { isConfigJob, reviewPrNumber } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

type Translate = (key: string) => string
export type JobLabelInput = { command: string; feature: string; threadTitle: string | null }

/** The feature cell and page title of a job. */
export function jobFeatureLabel(job: JobLabelInput, t: Translate): string {
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

/**
 * The labels a cancel, requeue or config response cannot carry: only the list and get routes resolve
 * `requesterName` and `threadTitle`, so a mutation response sends both as null. Applying it to a page
 * must not drop the labels already on screen — until another successful GET arrives, and forever when
 * none does. Labels are carried over per field, and only for the same job.
 */
export function preserveJobLabels(next: FleetJobDto, previous: FleetJobDto | null): FleetJobDto {
  if (previous === null || previous.id !== next.id) return next
  return {
    ...next,
    requesterName: next.requesterName ?? previous.requesterName,
    threadTitle: next.threadTitle ?? previous.threadTitle,
  }
}
