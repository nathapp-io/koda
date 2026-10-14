import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import type { ThreadDetailDto } from '~/lib/thread-types'

const detail = (): ThreadDetailDto => ({
  id: 't', repoId: 'repo', baseRef: 'main', feature: 'f', title: 'title', createdById: 'u', runnerId: null,
  backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: '5', costUsd: '0',
  tokens: null, specPath: 'spec.md', pendingQuestion: null, session: null, lastActivityAt: '', createdAt: '',
  activeJob: null, sendRefusal: null, writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
  handoff: { plan: null, run: null },
})
const g = globalThis as Record<string, unknown>

describe('useThreadHandoffJobs', () => {
  afterEach(() => { delete g.useApi })

  test('AC-15: watches thread updates and fetches their job details', async () => {
    const get = jest.fn(async () => ({ id: 'r1', state: 'RUNNING' }))
    g.useApi = () => ({ $api: { get } })
    const { useThreadHandoffJobs } = await import('~/composables/useThreadHandoffJobs')
    const thread = ref<ThreadDetailDto | null>(null)
    useThreadHandoffJobs('web', thread)
    thread.value = { ...detail(), handoff: { plan: null, run: { jobId: 'r1', state: 'RUNNING', stateReason: null } } }
    await nextTick()
    await new Promise(resolve => setImmediate(resolve))
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs/r1')
  })
})
