import { describe, expect, test } from '@jest/globals'
import { jobStateDotClass } from '../../lib/fleet-job-state'

describe('jobStateDotClass', () => {
  test.each([
    ['QUEUED', 'bg-status-todo'],
    ['ASSIGNED', 'bg-status-todo'],
    ['RUNNING', 'bg-status-active'],
    ['UPLOADING', 'bg-status-active'],
    ['COMPLETED', 'bg-status-done'],
    ['ESCALATED', 'bg-status-review'],
    ['FAILED', 'bg-status-rejected'],
    ['CRASHED', 'bg-status-rejected'],
    ['CANCELLED', 'bg-status-todo'],
  ])('%s -> %s', (state, cls) => {
    expect(jobStateDotClass(state)).toBe(cls)
  })

  test('an unknown state (a newer API) gets the neutral dot', () => {
    expect(jobStateDotClass('HIBERNATING')).toBe('bg-muted-foreground')
  })
})
