import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '~/lib/fleet-types'

const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'config', 'ConfigJobPanel.vue'), { props, components: uiStubs, globals: { useI18n: () => enI18n() } })
const job = (over: Partial<FleetJobDto>): FleetJobDto => ({
  id: 'j1', repoId: 'r1', command: 'CONFIG_EDIT', state: 'COMPLETED', resultPrUrl: null,
  configEdit: { mode: 'edit', files: ['.nax/context.md'], prTitle: 'Edit context', result: null },
  ...over,
} as FleetJobDto)

describe('ConfigJobPanel (S3 §6)', () => {
  test('ok: outcome, edited files and the PR link', () => {
    const app = mount({ slug: 'p', canWork: true, job: job({ resultPrUrl: 'https://github.com/acme/app/pull/9', configEdit: { mode: 'edit', files: ['.nax/context.md'], prTitle: 'Edit context', result: { outcome: 'ok', files: ['.nax/context.md', 'AGENTS.md'] } } }) })
    expect(app.one('[data-testid="config-panel-outcome"]')?.props['data-outcome']).toBe('ok')
    expect(app.find('[data-testid="config-panel-file"]').map((n) => app.textOf(n))).toEqual(['.nax/context.md'])
    expect(app.one('[data-testid="config-panel-pr"]')?.props.href).toBe('https://github.com/acme/app/pull/9')
    expect(app.one('[data-testid="config-panel-reopen"]')).toBeUndefined()
  })

  test('conflict and invalid offer Reopen edits to a DEVELOPER+; invalid shows the nax output', () => {
    const conflict = mount({ slug: 'p', canWork: true, job: job({ state: 'FAILED', configEdit: { mode: 'edit', files: ['.nax/context.md'], prTitle: 'T', result: { outcome: 'conflict', files: ['.nax/context.md'] } } }) })
    expect(conflict.one('[data-testid="config-panel-reopen"]')?.props.to).toBe('/p/fleet/repos/r1/config?reopen=j1')
    expect(conflict.find('[data-testid="config-panel-result-file"]').map((n) => conflict.textOf(n))).toEqual(['.nax/context.md'])
    const invalid = mount({ slug: 'p', canWork: true, job: job({ state: 'FAILED', configEdit: { mode: 'edit', files: ['.nax/rules/a.md'], prTitle: 'T', result: { outcome: 'invalid', output: 'rules lint: bad frontmatter in a.md' } } }) })
    const output = invalid.one('[data-testid="config-panel-output"]')
    expect(output).toBeDefined()
    expect(invalid.textOf(output)).toContain('bad frontmatter')
    expect(invalid.one('[data-testid="config-panel-reopen"]')).toBeDefined()
    const viewer = mount({ slug: 'p', canWork: false, job: job({ state: 'FAILED', configEdit: { mode: 'edit', files: [], prTitle: 'T', result: { outcome: 'conflict', files: [] } } }) })
    expect(viewer.one('[data-testid="config-panel-reopen"]')).toBeUndefined()
  })

  test('drift with files offers a regenerate PR; drift without files says the repo is in sync', () => {
    const drift = mount({ slug: 'p', canWork: true, job: job({ command: 'CONFIG_DRIFT', configEdit: { mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: ['AGENTS.md', 'CLAUDE.md'] } } }) })
    expect(drift.find('[data-testid="config-panel-result-file"]')).toHaveLength(2)
    ;(drift.one('[data-testid="config-panel-regenerate"]')?.props.onClick as () => void)()
    expect(drift.emitted('regenerate')).toEqual([[]])
    const clean = mount({ slug: 'p', canWork: true, job: job({ command: 'CONFIG_DRIFT', configEdit: { mode: 'drift', files: [], prTitle: null, result: { outcome: 'drift', files: [] } } }) })
    expect(clean.one('[data-testid="config-panel-regenerate"]')).toBeUndefined()
    expect(clean.text()).toContain('in sync')
  })

  test('before a result arrives the panel says the job is still working', () => {
    const app = mount({ slug: 'p', canWork: true, job: job({ state: 'RUNNING' }) })
    expect(app.one('[data-testid="config-panel-outcome"]')).toBeUndefined()
    expect(app.text()).toContain('No result yet')
  })
})
