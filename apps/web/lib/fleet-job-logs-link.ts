import type { FleetJobLogListDto } from '~/lib/fleet-log-types'

/** S2a §4.2: attempts whose log streams the server stores (a v3 runner, or the bundle fallback), latest first. */
export function logAttemptEpochs(list: FleetJobLogListDto | null): number[] {
  return (list?.attempts ?? []).filter((a) => a.streams.length > 0).map((a) => a.leaseEpoch)
}

/**
 * D357: retention expires an attempt's logs and bundle together (spec §5), so an expired stream in the latest attempt
 * means the bundle is gone too. A job whose latest attempt has no streams (a v1/v2 runner) learns it from the
 * download's 410 instead.
 */
export function bundleExpiredByLogs(list: FleetJobLogListDto | null): boolean {
  const latest = list?.attempts[0]
  return latest !== undefined && latest.streams.some((s) => s.expired)
}
