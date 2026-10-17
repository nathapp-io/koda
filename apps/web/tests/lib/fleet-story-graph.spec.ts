import { describe, test, expect } from '@jest/globals'
import { CLASSIC_STAGE_KEYS, STAGE_KEYS, WORKFLOW_STAGE_KEYS, edgePath, edgePaths, layoutStoryGraph, neighbourhood, pipelineStages } from '~/lib/fleet-story-graph'
import type { StoryRow } from '~/lib/fleet-jobs'
import type { FleetJobDto, FleetJobWorkflowOutcome } from '~/lib/fleet-types'

const row = (id: string, dependsOn: string[] = []): StoryRow => ({
  id, title: id, status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline', dependsOn,
})
const ids = (columns: StoryRow[][]): string[][] => columns.map(column => column.map(r => r.id))

describe('layoutStoryGraph (D430)', () => {
  test('no rows give an empty layout', () => {
    expect(layoutStoryGraph([])).toEqual({ columns: [], edges: [], unresolved: [] })
  })

  test('linear chain: one story per column', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['B'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B'], ['C']])
    expect(layout.edges).toEqual([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])
    expect(layout.unresolved).toEqual([])
  })

  test('diamond and isolated roots: column = 1 + deepest dependency', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A']), row('D', ['B', 'C']), row('E')])
    expect(ids(layout.columns)).toEqual([['A', 'E'], ['B', 'C'], ['D']])
    expect(layout.edges).toHaveLength(4)
  })

  test('a story sits right of its DEEPEST dependency, not its first', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A', 'B'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B'], ['C']])
  })

  test('fan-in and fan-out', () => {
    expect(ids(layoutStoryGraph([row('A'), row('B'), row('C'), row('D', ['A', 'B', 'C'])]).columns)).toEqual([['A', 'B', 'C'], ['D']])
    expect(ids(layoutStoryGraph([row('A'), row('B', ['A']), row('C', ['A']), row('D', ['A'])]).columns)).toEqual([['A'], ['B', 'C', 'D']])
  })

  test('a dependency on an unknown id is reported, not drawn', () => {
    const layout = layoutStoryGraph([row('A'), row('B', ['A', 'GONE'])])
    expect(ids(layout.columns)).toEqual([['A'], ['B']])
    expect(layout.edges).toEqual([{ from: 'A', to: 'B' }])
    expect(layout.unresolved).toEqual([{ story: 'B', dep: 'GONE', reason: 'unknown' }])
  })

  test('a 2-cycle is broken at the back edge and every story still renders', () => {
    const layout = layoutStoryGraph([row('A', ['B']), row('B', ['A'])])
    expect(layout.columns.flat().map(r => r.id).sort()).toEqual(['A', 'B'])
    expect(layout.edges).toHaveLength(1)
    expect(layout.unresolved).toEqual([{ story: 'B', dep: 'A', reason: 'cycle' }])
  })

  test('a 3-cycle is broken once', () => {
    const layout = layoutStoryGraph([row('A', ['C']), row('B', ['A']), row('C', ['B'])])
    expect(layout.columns.flat()).toHaveLength(3)
    expect(layout.edges).toHaveLength(2)
    expect(layout.unresolved.filter(u => u.reason === 'cycle')).toHaveLength(1)
  })

  test('a self-loop that reaches the layout is treated as a cycle', () => {
    const layout = layoutStoryGraph([row('A', ['A'])])
    expect(ids(layout.columns)).toEqual([['A']])
    expect(layout.edges).toEqual([])
    expect(layout.unresolved).toEqual([{ story: 'A', dep: 'A', reason: 'cycle' }])
  })

  test('duplicate ids: the first occurrence wins', () => {
    const first = { ...row('A'), title: 'first' }
    const layout = layoutStoryGraph([first, { ...row('A'), title: 'second' }, row('B', ['A'])])
    expect(layout.columns.flat().map(r => r.title)).toEqual(['first', 'B'])
  })

  test('barycentre: a column is ordered by the mean position of its dependencies', () => {
    // PRD order puts C (depends on B) before D (depends on A); A sits above B, so D goes first.
    const layout = layoutStoryGraph([row('A'), row('B'), row('C', ['B']), row('D', ['A'])])
    expect(ids(layout.columns)).toEqual([['A', 'B'], ['D', 'C']])
  })

  test('barycentre ties keep PRD order', () => {
    expect(ids(layoutStoryGraph([row('A'), row('C', ['A']), row('B', ['A'])]).columns)).toEqual([['A'], ['C', 'B']])
  })

  test('the input rows are not mutated', () => {
    const rows = [row('A', ['B']), row('B', ['A'])]
    const before = JSON.stringify(rows)
    layoutStoryGraph(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })

  test('100 stories x 10 dependencies lay out in milliseconds, not seconds (fastest of 20 runs)', () => {
    // The budget is on the FASTEST of 20 runs, and it is generous, because a wall-clock assertion in
    // a unit suite measures the machine as much as the code: this layout takes ~0.55 ms idle, ~1.3 ms
    // with 16 busy cores, yet a review box read a 5.88 ms MEDIAN for the very same code while turbo
    // ran the api and web suites side by side (0.55 ms -> 5.88 ms is contention, not a regression).
    // The fastest run estimates the layout's own cost at any load, so the guard the D430 claim needs
    // survives: the measured cost sits ~45x under the budget, and only an order-of-magnitude
    // complexity regression can breach it.
    const budgetMs = 25
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(`US-${i}`, Array.from({ length: Math.min(i, 10) }, (_, k) => `US-${i - k - 1}`)))
    // Warm-up: the first call of a size pays for JIT compilation, which is not the layout's cost.
    layoutStoryGraph(rows)
    let fastest = Number.POSITIVE_INFINITY
    for (let i = 0; i < 20; i += 1) {
      const start = performance.now()
      layoutStoryGraph(rows)
      fastest = Math.min(fastest, performance.now() - start)
    }
    expect(fastest).toBeLessThan(budgetMs)
    expect(layoutStoryGraph(rows).columns).toHaveLength(100)
  })
})

describe('edge geometry (D431, D444)', () => {
  const a = { x: 0, y: 0, width: 100, height: 40 }
  const b = { x: 200, y: 60, width: 100, height: 40 }

  test('a cubic from the right middle of the dependency to the left middle of the dependent', () => {
    expect(edgePath(a, b)).toBe('M 100 20 C 150 20, 150 80, 200 80')
  })

  test('close columns still bend by at least 24 px', () => {
    expect(edgePath(a, { x: 120, y: 0, width: 100, height: 40 })).toBe('M 100 20 C 124 20, 96 20, 120 20')
  })

  test('an edge whose endpoint has no measured box is dropped', () => {
    const paths = edgePaths([{ from: 'A', to: 'B' }, { from: 'A', to: 'GONE' }], { A: a, B: b })
    expect(paths).toEqual([{ from: 'A', to: 'B', d: 'M 100 20 C 150 20, 150 80, 200 80' }])
  })
})

describe('neighbourhood', () => {
  const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'X', to: 'Y' }]

  test('nothing active means no emphasis', () => {
    expect(neighbourhood(edges, null)).toBeNull()
  })

  test('the active story plus its direct dependencies and dependents', () => {
    expect([...(neighbourhood(edges, 'B') ?? [])].sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('pipelineStages (spec §2.1, D442)', () => {
  type StageJob = Parameters<typeof pipelineStages>[0]
  const story = (id: string, status: string) => ({ id, title: id, status, attempts: 1, dependsOn: [] })
  const run = (over: Partial<StageJob> = {}): StageJob => ({
    command: 'RUN', state: 'RUNNING', postRun: null, currentStoryId: null, currentPhase: null,
    stories: [story('US-001', 'passed'), story('US-002', 'in-progress')], ...over,
  })
  const states = (job: StageJob): string[][] => pipelineStages(job).map(s => [s.key, s.state])

  test('PLAN jobs have no strip', () => {
    expect(pipelineStages(run({ command: 'PLAN' }))).toEqual([])
  })

  test('an active RUN with a story in progress and no postRun yet', () => {
    expect(states(run())).toEqual([['stories', 'running'], ['acceptance', 'pending'], ['regression', 'pending'], ['finish', 'pending']])
  })

  test('postRun values map: not-run -> pending, known values kept', () => {
    const job = run({ postRun: { acceptance: 'passed', regression: 'running', finish: 'not-run' } })
    expect(states(job).slice(1)).toEqual([['acceptance', 'passed'], ['regression', 'running'], ['finish', 'pending']])
    expect(pipelineStages(job).map(s => s.variant)).toEqual(['secondary', 'default', 'secondary', 'outline'])
  })

  test('an unknown nax value is kept raw and marked unknown to the copy', () => {
    const stage = pipelineStages(run({ postRun: { finish: 'escalated' } }))[3]
    expect(stage).toEqual({ key: 'finish', state: 'escalated', known: false, variant: 'outline' })
  })

  test('a terminal job without postRun reads unknown, not pending', () => {
    expect(states(run({ state: 'COMPLETED' })).slice(1).map(([, s]) => s)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  test('Stories: any failed story fails the stage', () => {
    expect(states(run({ stories: [story('US-001', 'passed'), story('US-002', 'failed')] }))[0]).toEqual(['stories', 'failed'])
  })

  test('Stories: passed, skipped, decomposed and regression-failed all count as done (D442)', () => {
    const done = [story('A', 'passed'), story('B', 'skipped'), story('C', 'decomposed'), story('D', 'regression-failed')]
    expect(states(run({ stories: done }))[0]).toEqual(['stories', 'passed'])
  })

  test('Stories: an unknown story status is not done', () => {
    expect(states(run({ state: 'COMPLETED', stories: [story('A', 'passed'), story('B', 'mystery')] }))[0]).toEqual(['stories', 'pending'])
  })

  test('Stories: in-progress on a terminal job is not running', () => {
    expect(states(run({ state: 'CANCELLED' }))[0]).toEqual(['stories', 'pending'])
  })

  test('no story list keeps the Stories chip pending', () => {
    expect(states(run({ stories: null }))[0]).toEqual(['stories', 'pending'])
  })

  test('typed on the real DTO', () => {
    const dto = { command: 'RUN', state: 'QUEUED', postRun: null, stories: null, currentStoryId: null, currentPhase: null } as unknown as FleetJobDto
    expect(pipelineStages(dto)).toHaveLength(4)
  })
})

describe('pipelineStages workflow mode (D6)', () => {
  type StageJob = Parameters<typeof pipelineStages>[0]
  const story = (id: string, status: string) => ({ id, title: id, status, attempts: 1, dependsOn: [] })
  const run = (over: Partial<StageJob> = {}): StageJob => ({
    command: 'RUN', state: 'RUNNING', postRun: null, currentStoryId: null, currentPhase: null,
    stories: [story('US-001', 'passed'), story('US-002', 'in-progress')], ...over,
  })
  const workflow = (outcome: FleetJobWorkflowOutcome): StageJob['workflow'] => ({ outcome } as StageJob['workflow'])
  const keys = (job: StageJob): string[] => pipelineStages(job).map(stage => stage.key)
  const states = (job: StageJob): string[][] => pipelineStages(job).map(stage => [stage.key, stage.state])
  /** The three workflow stages; Stories and Acceptance keep their own rules. */
  const groups = (job: StageJob): string[][] => states(job).slice(2)

  test('AC-1: a RUNNING RUN with a workflow step gets the five workflow stages, in order', () => {
    expect(keys(run({ postRun: { workflowStep: 'branch-review' } })))
      .toEqual(['stories', 'acceptance', 'review', 'gates', 'publish'])
  })

  test('AC-2: step branch-review runs the review group; gates and publish wait', () => {
    expect(groups(run({ postRun: { workflowStep: 'branch-review' } })))
      .toEqual([['review', 'running'], ['gates', 'pending'], ['publish', 'pending']])
  })

  test('AC-3: step gate-repair has review passed and gates running', () => {
    expect(groups(run({ postRun: { workflowStep: 'gate-repair' } })))
      .toEqual([['review', 'passed'], ['gates', 'running'], ['publish', 'pending']])
  })

  test('AC-4: a step done with outcome ready passes every workflow group', () => {
    const job = run({ state: 'COMPLETED', postRun: { workflowStep: 'done' }, workflow: workflow('ready') })
    expect(groups(job)).toEqual([['review', 'passed'], ['gates', 'passed'], ['publish', 'passed']])
  })

  test('AC-5: outcome draft is shown raw on the publish stage', () => {
    const job = run({ state: 'ESCALATED', postRun: { workflowStep: 'done' }, workflow: workflow('draft') })
    expect(pipelineStages(job)[4]).toEqual({ key: 'publish', state: 'draft', known: false, variant: 'outline' })
  })

  test('AC-6: outcome local-only fails publish', () => {
    const job = run({ state: 'FAILED', postRun: { workflowStep: 'done' }, workflow: workflow('local-only') })
    expect(groups(job)[2]).toEqual(['publish', 'failed'])
  })

  test('AC-7: a FAILED RUN at final-gates fails gates and skips publish', () => {
    expect(groups(run({ state: 'FAILED', postRun: { workflowStep: 'final-gates' } })))
      .toEqual([['review', 'passed'], ['gates', 'failed'], ['publish', 'skipped']])
  })

  test('AC-8: currentPhase implement alone is workflow mode, with the groups pending', () => {
    const job = run({ postRun: null, workflow: null, currentPhase: 'implement', state: 'RUNNING' })
    expect(keys(job)).toEqual(['stories', 'acceptance', 'review', 'gates', 'publish'])
    expect(groups(job)).toEqual([['review', 'pending'], ['gates', 'pending'], ['publish', 'pending']])
  })

  test('AC-9: a step in no group leaves all three groups pending', () => {
    expect(groups(run({ postRun: { workflowStep: 'mystery' } })))
      .toEqual([['review', 'pending'], ['gates', 'pending'], ['publish', 'pending']])
  })

  test('AC-10: a pipeline-mode RUN keeps the four classic stages and their states', () => {
    const job = run({ currentPhase: 'execution', workflow: null, postRun: { acceptance: 'passed', regression: 'running' } })
    expect(states(job)).toEqual([
      ['stories', 'running'], ['acceptance', 'passed'], ['regression', 'running'], ['finish', 'pending'],
    ])
  })

  test('AC-12: a FAILED RUN at done without a workflow result reads publish unknown', () => {
    const job = run({ state: 'FAILED', postRun: { workflowStep: 'done' }, workflow: null })
    expect(groups(job)[2]).toEqual(['publish', 'unknown'])
  })

  test('AC-13: an UPLOADING RUN at done without a workflow result has publish running', () => {
    const job = run({ state: 'UPLOADING', postRun: { workflowStep: 'done' }, workflow: null })
    expect(groups(job)[2]).toEqual(['publish', 'running'])
  })

  test('a job DTO without the workflow signal is not workflow mode (a caller may omit it)', () => {
    expect(keys(run({ currentPhase: 'execution' })))
      .toEqual(['stories', 'acceptance', 'regression', 'finish'])
  })

  test('the exported key lists match what each mode renders', () => {
    expect(keys(run({ postRun: { workflowStep: 'branch-review' } }))).toEqual([...WORKFLOW_STAGE_KEYS])
    expect(keys(run({ currentPhase: 'execution' }))).toEqual([...CLASSIC_STAGE_KEYS])
    expect([...STAGE_KEYS].sort()).toEqual([...CLASSIC_STAGE_KEYS, 'review', 'gates', 'publish'].sort())
  })

  test('every step of a group lands on that group', () => {
    for (const step of ['repo-gates', 'branch-review', 'branch-fix', 'branch-rereview', 'adjudicate']) {
      expect(groups(run({ postRun: { workflowStep: step } }))[0]).toEqual(['review', 'running'])
    }
    expect(groups(run({ postRun: { workflowStep: 'gate-repair' } }))[1]).toEqual(['gates', 'running'])
    expect(groups(run({ postRun: { workflowStep: 'publish' } })))
      .toEqual([['review', 'passed'], ['gates', 'passed'], ['publish', 'running']])
  })
})
