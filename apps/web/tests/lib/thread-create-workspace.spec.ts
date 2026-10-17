import { describe, expect, test } from '@jest/globals'
import { eligibleModels } from '~/lib/thread-create'
import type { FleetRunnerSummary } from '~/lib/fleet-types'

/**
 * US-004 (fleet S5b 1d): the WORKSPACE half of the scope-aware model list. A WORKSPACE thread is
 * hosted by a runner that advertises `workspaceThreads`, and it is not project-scoped, so a
 * project capability must not open or close the WORKSPACE list (and vice versa).
 */

/** A runner summary as the API sends it; both thread capabilities are always present. */
const runner = (over: Partial<FleetRunnerSummary> = {}): FleetRunnerSummary => ({
  id: 'rn1',
  name: 'mac-1',
  os: 'linux',
  arch: 'x64',
  labels: [],
  enabled: true,
  online: true,
  profiles: [],
  threadBackends: { native: [], acp: [] },
  projectThreads: false,
  workspaceThreads: false,
  ...over,
})

describe('eligibleModels scope (US-004 AC-1-AC-2)', () => {
  test('AC-1: WORKSPACE keeps only the models of online enabled runners advertising workspaceThreads', () => {
    expect(eligibleModels([
      runner({ id: 'a', workspaceThreads: true, threadBackends: { native: ['m1'], acp: [] } }),
      runner({ id: 'b', workspaceThreads: false, threadBackends: { native: ['m2'], acp: [] } }),
    ], 'WORKSPACE')).toEqual(['m1'])
  })

  test('AC-2: PROJECT is unchanged by workspaceThreads', () => {
    expect(eligibleModels([
      runner({ id: 'a', projectThreads: true, workspaceThreads: true, threadBackends: { native: ['m1'], acp: [] } }),
      runner({ id: 'b', projectThreads: true, workspaceThreads: false, threadBackends: { native: ['m2'], acp: [] } }),
    ], 'PROJECT')).toEqual(['m1', 'm2'])
  })

  test('AC-2 (boundary): REPO is unchanged by workspaceThreads', () => {
    expect(eligibleModels([
      runner({ id: 'a', workspaceThreads: true, threadBackends: { native: ['m1'], acp: [] } }),
      runner({ id: 'b', workspaceThreads: false, threadBackends: { native: ['m2'], acp: [] } }),
    ], 'REPO')).toEqual(['m1', 'm2'])
  })

  test('AC-1 (boundary): an offline or disabled runner offers no WORKSPACE model', () => {
    expect(eligibleModels([
      runner({ id: 'a', online: false, workspaceThreads: true, threadBackends: { native: ['m1'], acp: [] } }),
      runner({ id: 'b', enabled: false, workspaceThreads: true, threadBackends: { native: ['m2'], acp: [] } }),
    ], 'WORKSPACE')).toEqual([])
  })

  test('AC-1 (boundary): an ACP-only runner offers no WORKSPACE model (ACP is refused for WORKSPACE)', () => {
    expect(eligibleModels([
      runner({ workspaceThreads: true, threadBackends: { native: [], acp: ['claude'] } }),
    ], 'WORKSPACE')).toEqual([])
  })
})
