import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetRepoConfig.ts')
const g = globalThis as Record<string, unknown>
const withApi = (api: Record<string, jest.Mock>) => { g.useApi = () => ({ $api: api }) }

describe('useFleetRepoConfig (S3 §4)', () => {
  beforeEach(() => { g.useApi = undefined })

  test('list and read hit the repo routes with encoded segments and the ref', async () => {
    const get = jest.fn(async () => ({}))
    withApi({ get })
    const { useFleetRepoConfig } = await import(composablePath)
    const api = useFleetRepoConfig('my proj')
    await api.list('r 1')
    await api.read('r1', '.nax/rules/a.md', 'abc123')
    expect(get).toHaveBeenNthCalledWith(1, '/projects/my%20proj/fleet/repos/r%201/nax-files')
    expect(get).toHaveBeenNthCalledWith(2, '/projects/my%20proj/fleet/repos/r1/nax-files/content', { query: { path: '.nax/rules/a.md', ref: 'abc123' } })
  })

  test('submitEdit, submitRegenerate and submitDrift post to their routes; prBody is omitted when empty', async () => {
    const post = jest.fn(async () => ({ job: { id: 'j1' }, placement: { assigned: false, runnerId: null, misfits: [] } }))
    withApi({ post })
    const { useFleetRepoConfig } = await import(composablePath)
    const api = useFleetRepoConfig('p')
    const edits = [{ path: '.nax/context.md', op: 'put', content: 'x', baseSha: 's' }]
    expect((await api.submitEdit('r1', { baseSha: 'b', edits, prTitle: 'T', prBody: '' })).job.id).toBe('j1')
    await api.submitRegenerate('r1', { prTitle: 'Regen', prBody: 'why' })
    await api.submitDrift('r1')
    expect(post).toHaveBeenNthCalledWith(1, '/projects/p/fleet/repos/r1/config-edits', { baseSha: 'b', edits, prTitle: 'T' })
    expect(post).toHaveBeenNthCalledWith(2, '/projects/p/fleet/repos/r1/config-edits/regenerate', { prTitle: 'Regen', prBody: 'why' })
    expect(post).toHaveBeenNthCalledWith(3, '/projects/p/fleet/repos/r1/drift-checks', {})
  })

  test('jobEdits reads the stored edit set; activeConfigJob finds the active nax-config job of the repo', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/config-edit')
      ? { mode: 'edit', edits: [], prTitle: 'T', prBody: null, baseSha: 'b' }
      : { records: [{ id: 'old', state: 'FAILED' }, { id: 'live', state: 'RUNNING' }], total: 2, current: 1, size: 20, hasNext: false, hasPrev: false }))
    withApi({ get })
    const { useFleetRepoConfig } = await import(composablePath)
    const api = useFleetRepoConfig('p')
    expect((await api.jobEdits('j9')).mode).toBe('edit')
    expect(get).toHaveBeenCalledWith('/projects/p/fleet/jobs/j9/config-edit')
    expect((await api.activeConfigJob('r1'))?.id).toBe('live')
    expect(get).toHaveBeenCalledWith('/projects/p/fleet/jobs', { query: { repoId: 'r1', feature: 'nax-config', size: '20' } })
  })
})
