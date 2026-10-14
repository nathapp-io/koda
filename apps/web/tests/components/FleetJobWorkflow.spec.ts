import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = webFile('components', 'fleet', 'FleetJobWorkflow.vue')

type WorkflowItem = {
  id: string
  kind: string
  issue: string
  severity: string | null
  file: string | null
  line: number | null
  suggestion: string | null
}

type Workflow = {
  runId: string
  outcome: string
  workflowPassed: boolean
  reasons: string[]
  openItems: WorkflowItem[]
}

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  runId: 'run-1',
  outcome: 'draft',
  workflowPassed: false,
  reasons: [],
  openItems: [],
  ...over,
})

const item = (over: Partial<WorkflowItem> = {}): WorkflowItem => ({
  id: 'item-1',
  kind: 'finding',
  issue: 'unchecked null',
  severity: null,
  file: null,
  line: null,
  suggestion: null,
  ...over,
})

const mount = (w: Workflow) =>
  mountSfc(file, {
    props: { workflow: w },
    components: uiStubs,
    globals: { useI18n: () => enI18n() },
  })

describe('FleetJobWorkflow (US-006)', () => {
  test('AC-1: outcome draft renders the draft outcome text', () => {
    const app = mount(workflow({ outcome: 'draft' }))
    const outcome = app.one('[data-testid="fleet-job-workflow-outcome"]')
    expect(outcome).toBeDefined()
    expect(app.textOf(outcome)).toBe(enI18n().t('fleet.jobs.workflow.outcome.draft'))
    expect(app.textOf(outcome)).toBe('Draft')
    app.unmount()
  })

  test('AC-2: outcome local-only renders the localOnly outcome text', () => {
    const app = mount(workflow({ outcome: 'local-only' }))
    const outcome = app.one('[data-testid="fleet-job-workflow-outcome"]')
    expect(outcome).toBeDefined()
    expect(app.textOf(outcome)).toBe(enI18n().t('fleet.jobs.workflow.outcome.localOnly'))
    expect(app.textOf(outcome)).toBe('Local only')
    app.unmount()
  })

  test('AC-3: two reasons render two items', () => {
    const app = mount(workflow({ reasons: ['CI failed: test', '1 open finding'] }))
    const list = app.one('[data-testid="fleet-job-workflow-reasons"]')
    expect(list).toBeDefined()
    const rows = app.find('li', list)
    expect(rows).toHaveLength(2)
    expect(app.textOf(rows[0])).toContain('CI failed: test')
    expect(app.textOf(rows[1])).toContain('1 open finding')
    app.unmount()
  })

  test('AC-4: empty reasons render no reasons element', () => {
    const app = mount(workflow({ reasons: [] }))
    expect(app.find('[data-testid="fleet-job-workflow-reasons"]')).toHaveLength(0)
    app.unmount()
  })

  test('AC-5: an open item row shows kind, severity, file:line and issue', () => {
    const app = mount(
      workflow({
        openItems: [item({ kind: 'finding', severity: 'major', file: 'src/a.ts', line: 7, issue: 'unchecked null' })],
      }),
    )
    const list = app.one('[data-testid="fleet-job-workflow-open-items"]')
    expect(list).toBeDefined()
    const rows = app.find('li', list)
    expect(rows).toHaveLength(1)
    const text = app.textOf(rows[0])
    expect(text).toContain('finding')
    expect(text).toContain('major')
    expect(text).toContain('src/a.ts:7')
    expect(text).toContain('unchecked null')
    app.unmount()
  })

  test('AC-6: an open item with a null line renders the file without a colon', () => {
    const app = mount(workflow({ openItems: [item({ file: 'src/b.ts', line: null })] }))
    const list = app.one('[data-testid="fleet-job-workflow-open-items"]')
    expect(list).toBeDefined()
    const text = app.textOf(app.find('li', list)[0])
    expect(text).toContain('src/b.ts')
    expect(text).not.toContain('src/b.ts:')
    app.unmount()
  })

  test('AC-7: empty open items render no open-items element', () => {
    const app = mount(workflow({ openItems: [] }))
    expect(app.find('[data-testid="fleet-job-workflow-open-items"]')).toHaveLength(0)
    app.unmount()
  })
})
