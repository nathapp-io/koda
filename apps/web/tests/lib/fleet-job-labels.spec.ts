import { jobFeatureLabel, jobRequesterLabel } from '~/lib/fleet-job-labels'
import type { FleetJobDto } from '~/lib/fleet-types'

const job = (overrides: Partial<FleetJobDto> = {}): FleetJobDto => ({
  command: 'RUN',
  feature: 'c3-clamp',
  threadTitle: null,
  requesterName: null,
  requestedById: 'u1',
  ...overrides,
} as FleetJobDto)

const t = (key: string): string => ({
  'fleet.jobs.threadFeature': 'Thread',
  'fleet.jobs.configFeature': 'Configuration',
  'common.formerMember': 'Former member',
}[key] ?? key)

describe('jobFeatureLabel', () => {
  it('AC-1: uses the title of a THREAD job', () => {
    expect(jobFeatureLabel(job({ command: 'THREAD', threadTitle: 'Fix login flow', feature: 'thread-cm1' }), t)).toBe('Fix login flow')
  })

  it('AC-2: uses the translated fallback when a THREAD title is null', () => {
    expect(jobFeatureLabel(job({ command: 'THREAD', threadTitle: null }), t)).toBe('Thread')
  })

  it('AC-3: uses the translated fallback when a THREAD title is blank', () => {
    expect(jobFeatureLabel(job({ command: 'THREAD', threadTitle: '   ' }), t)).toBe('Thread')
  })

  it('AC-4: formats a REVIEW feature as a PR number', () => {
    expect(jobFeatureLabel(job({ command: 'REVIEW', feature: 'review-pr-18' }), t)).toBe('PR #18')
  })

  it('AC-5: keeps an ordinary RUN feature even when threadTitle is set', () => {
    expect(jobFeatureLabel(job({ command: 'RUN', feature: 'c3-clamp', threadTitle: 'ignored' }), t)).toBe('c3-clamp')
  })

  it('AC-6: uses the translated config label for CONFIG_EDIT', () => {
    expect(jobFeatureLabel(job({ command: 'CONFIG_EDIT' }), t)).toBe('Configuration')
  })
})

describe('jobRequesterLabel', () => {
  it('AC-7: prefers the API requester name and does not look up the member', () => {
    const memberName = jest.fn((_id: string): string | null => 'Alice')
    expect(jobRequesterLabel(job({ requesterName: 'codex-bot' }), memberName, t)).toBe('codex-bot')
    expect(memberName).not.toHaveBeenCalled()
  })

  it('AC-8: falls back to the project member name', () => {
    const memberName = jest.fn((_id: string): string | null => 'Alice')
    expect(jobRequesterLabel(job({ requesterName: null }), memberName, t)).toBe('Alice')
    expect(memberName).toHaveBeenCalledWith('u1')
  })

  it('AC-9: uses the translated former-member fallback when no name is known', () => {
    expect(jobRequesterLabel(job({ requesterName: null }), () => null, t)).toBe('Former member')
  })
})
