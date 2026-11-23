import { jobFeatureLabel, jobRequesterLabel, preserveJobLabels } from '~/lib/fleet-job-labels'
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
  it("AC-1: accepts the minimal label input and uses a THREAD title", () => {
    expect(jobFeatureLabel({ command: 'THREAD', feature: 'thread-abc', threadTitle: 'Fix login' }, t)).toBe('Fix login')
  })

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

describe('preserveJobLabels (B1)', () => {
  it('keeps the requester and thread labels a mutation response sends as null', () => {
    const shown = job({ command: 'THREAD', id: 'j1', feature: 'thread-cm1', threadTitle: 'Fix login flow', requesterName: 'codex-bot' })
    // The cancel/requeue routes answer with the same job and both label fields null (spec, Out of Scope).
    const mutation = job({ command: 'THREAD', id: 'j1', feature: 'thread-cm1', state: 'CANCELLED', threadTitle: null, requesterName: null })

    const merged = preserveJobLabels(mutation, shown)

    expect(merged.threadTitle).toBe('Fix login flow')
    expect(merged.requesterName).toBe('codex-bot')
    // The response itself still wins for everything else.
    expect(merged.state).toBe('CANCELLED')
  })

  it('takes a label the response does carry over the one on screen', () => {
    const shown = job({ id: 'j1', requesterName: 'codex-bot', threadTitle: 'Old title' })
    const fresh = job({ id: 'j1', requesterName: 'Alice', threadTitle: null })

    expect(preserveJobLabels(fresh, shown).requesterName).toBe('Alice')
    expect(preserveJobLabels(fresh, shown).threadTitle).toBe('Old title')
  })

  it('returns the response unchanged when the page holds no job yet', () => {
    const mutation = job({ id: 'j1', requesterName: null, threadTitle: null })
    expect(preserveJobLabels(mutation, null)).toBe(mutation)
  })

  it('never carries labels from another job', () => {
    const other = job({ id: 'j0', requesterName: 'codex-bot', threadTitle: 'Another flow' })
    const mutation = job({ id: 'j1', requesterName: null, threadTitle: null })

    const merged = preserveJobLabels(mutation, other)

    expect(merged.requesterName).toBeNull()
    expect(merged.threadTitle).toBeNull()
  })
})
