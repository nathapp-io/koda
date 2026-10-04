import { describe, expect, test } from '@jest/globals'
import { bundleExpiredByLogs, logAttemptEpochs } from '~/lib/fleet-job-logs-link'
import type { FleetJobLogAttemptDto, FleetJobLogStreamDto } from '~/lib/fleet-log-types'

const stream = (over: Partial<FleetJobLogStreamDto> = {}): FleetJobLogStreamDto => ({
  stream: 'run', sizeBytes: 10, complete: true, truncated: false, source: 'stream', expired: false, updatedAt: 'x', ...over,
})
const attempt = (leaseEpoch: number, streams: FleetJobLogStreamDto[], legacySampled = false): FleetJobLogAttemptDto => ({ leaseEpoch, legacySampled, streams })

describe('logAttemptEpochs (spec §4.2)', () => {
  test('only attempts with stored streams, latest first; nothing before the list loads', () => {
    expect(logAttemptEpochs({ attempts: [attempt(3, [stream()]), attempt(2, [], true), attempt(1, [stream()])] })).toEqual([3, 1])
    expect(logAttemptEpochs(null)).toEqual([])
  })
})

describe('bundleExpiredByLogs (D357)', () => {
  test('the latest attempt has an expired stream: the bundle is gone too', () => {
    expect(bundleExpiredByLogs({ attempts: [attempt(1, [stream({ expired: true })])] })).toBe(true)
  })

  test('a newer attempt after a requeue, or a newer v1/v2 attempt without streams, keeps the button', () => {
    expect(bundleExpiredByLogs({ attempts: [attempt(2, [stream()]), attempt(1, [stream({ expired: true })])] })).toBe(false)
    expect(bundleExpiredByLogs({ attempts: [attempt(2, [], true), attempt(1, [stream({ expired: true })])] })).toBe(false)
    expect(bundleExpiredByLogs(null)).toBe(false)
  })
})
