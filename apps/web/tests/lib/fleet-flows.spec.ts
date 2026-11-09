import { describe, expect, test } from '@jest/globals'
import {
  featureBranch,
  featureStateKey,
  flowStateKey,
  flowStepKey,
  isLiveFlow,
  isPendingFlowAnswer,
  jobsByFeature,
  openQuestions,
  prUrl,
} from '~/lib/fleet-flows'
import type { FleetFlowDto, FleetFlowFeatureDto, FleetFlowJobDto } from '~/lib/fleet-flows'

const feature = (over: Partial<FleetFlowFeatureDto> = {}): FleetFlowFeatureDto => ({
  feature: 'f1', specPath: 'docs/f1.md', branch: null, dependsOn: [], state: 'PENDING', currentStep: null,
  prNumber: null, questionsJobId: null, questions: null, answers: null, answeredAt: null, ...over,
})

const flow = (over: Partial<FleetFlowDto> = {}): FleetFlowDto => ({
  id: 'flow1', projectId: 'p1', repoId: 'r1', threadId: null, entry: 'NAX', createdBy: { type: 'USER', id: 'u1' },
  branch: 'flow/branch', specSha: 'sha', pinnedRunnerId: null, roles: { reviewer: 'reviewer', supervisor: 'supervisor' },
  costCapUsd: '10.0000', spentUsd: '0.0000', state: 'RUNNING', approval: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: '2026-11-09T00:00:00.000Z', features: [], url: '/p/flows/flow1', ...over,
})

const job = (id: string, featureName: string | null): FleetFlowJobDto => ({
  id, feature: featureName, step: null, command: 'RUN', state: 'COMPLETED', costUsd: '0.0000',
  queuedAt: '2026-11-09T00:00:00.000Z', finishedAt: null,
})

describe('fleet flow helpers', () => {
  test('AC-1: recognizes each live flow state', () => {
    expect(['PENDING', 'APPROVED', 'RUNNING', 'WAITING_MERGE', 'WAITING_ANSWER'].map(isLiveFlow)).toEqual([true, true, true, true, true])
  })

  test('AC-2: completed and stopped flows are not live', () => {
    expect(['COMPLETED', 'STOPPED'].map(isLiveFlow)).toEqual([false, false])
  })

  test('AC-3: maps known flow state labels and leaves unknown states unmapped', () => {
    expect(flowStateKey('RUNNING')).toBe('fleet.flows.state.RUNNING')
    expect(flowStateKey('BOGUS')).toBeNull()
  })

  test('AC-4: prefers a feature branch and falls back to the flow branch', () => {
    expect(featureBranch(flow(), feature({ branch: 'feat/f1' }))).toBe('feat/f1')
    expect(featureBranch(flow({ branch: 'main' }), feature())).toBe('main')
  })

  test('AC-5: builds a GitHub pull request URL', () => {
    expect(prUrl({ provider: 'github', owner: 'o', name: 'r' }, 33)).toBe('https://github.com/o/r/pull/33')
  })

  test('AC-6: does not link non-GitHub repos or missing repo/PR', () => {
    expect(prUrl({ provider: 'gitlab', owner: 'o', name: 'r' }, 33)).toBeNull()
    expect(prUrl(null, 33)).toBeNull()
    expect(prUrl({ provider: 'github', owner: 'o', name: 'r' }, null)).toBeNull()
  })

  test('AC-7: groups feature jobs in input order and includes empty feature entries', () => {
    const features = [feature({ feature: 'first' }), feature({ feature: 'empty' }), feature({ feature: 'last' })]
    const jobs = [job('j1', 'last'), job('j2', 'first'), job('j3', 'last')]
    const grouped = jobsByFeature(jobs, features)
    expect([...grouped.byFeature.entries()]).toEqual([
      ['first', [jobs[1]]], ['empty', []], ['last', [jobs[0], jobs[2]]],
    ])
    expect(grouped.flowJobs).toEqual([])
  })

  test('AC-8: returns null-feature jobs separately', () => {
    const flowJob = job('flow-job', null)
    expect(jobsByFeature([job('feature-job', 'f1'), flowJob], [feature()]).flowJobs).toEqual([flowJob])
  })

  test('AC-9: returns questions only while unanswered and present', () => {
    const questions = [{ id: 'q1', question: 'What?' }]
    expect(openQuestions(feature({ questions }))).toEqual(questions)
    expect(openQuestions(feature({ questions, answeredAt: '2026-11-09T00:00:00.000Z' }))).toEqual([])
    expect(openQuestions(feature({ questions: null }))).toEqual([])
  })

  test('AC-10: safely identifies pending approval answers', () => {
    expect(isPendingFlowAnswer({ permissionKey: 'fleet.flow.answer' })).toBe(true)
    expect(isPendingFlowAnswer(flow())).toBe(false)
    expect(isPendingFlowAnswer(null)).toBe(false)
    expect(isPendingFlowAnswer('permissionKey')).toBe(false)
  })

  test('AC-11: maps known feature-state labels and leaves unknown states unmapped', () => {
    expect(featureStateKey('MERGED')).toBe('fleet.flows.featureState.MERGED')
    expect(featureStateKey('BOGUS')).toBeNull()
  })

  test('AC-12: maps known steps and returns null for a null step', () => {
    expect(flowStepKey('PRD_REVIEW')).toBe('fleet.flows.step.PRD_REVIEW')
    expect(flowStepKey(null)).toBeNull()
  })
})
