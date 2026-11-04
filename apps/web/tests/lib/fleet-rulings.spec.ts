import { expect, test } from '@jest/globals'
import { draftRunPrNumber } from '../../lib/fleet-rulings'
import type { FleetJobDto } from '../../lib/fleet-types'

const job = { command: 'RUN', workflow: { outcome: 'draft' }, resultPrUrl: 'https://github.com/o/r/pull/12' } as FleetJobDto

test('draft GitHub RUNs are eligible even with no open items or an already-ready PR result', () => {
  expect(draftRunPrNumber({ ...job, fixReady: { markedReady: true } })).toBe(12)
})
test.each([
  null, 'not a URL', 'javascript:alert(1)', 'http://github.com/o/r/pull/12',
  'https://gitlab.com/o/r/-/merge_requests/12', 'https://github.com.evil.test/o/r/pull/12',
  'https://user:pass@github.com/o/r/pull/12', 'https://github.com:8443/o/r/pull/12',
  'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/9007199254740992',
])('refuses unsupported PR URL %s', resultPrUrl => {
  expect(draftRunPrNumber({ ...job, resultPrUrl })).toBeNull()
})
test('ready, local-only and non-RUN jobs do not get the panel', () => {
  expect(draftRunPrNumber({ ...job, workflow: null })).toBeNull()
  expect(draftRunPrNumber({ ...job, command: 'REVIEW' })).toBeNull()
  expect(draftRunPrNumber({ ...job, workflow: { ...job.workflow, outcome: 'ready' } } as FleetJobDto)).toBeNull()
  expect(draftRunPrNumber({ ...job, workflow: { ...job.workflow, outcome: 'local-only' } } as FleetJobDto)).toBeNull()
})
