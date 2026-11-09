import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'
import type { FleetFlowDto, FleetFlowOverviewDto, FleetFlowPage } from '../../lib/fleet-flows'
import type { ApprovalRequestSummary } from '../../lib/approval-requests'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetFlows.ts')
const flow = { id: 'f1' } as FleetFlowDto
const overview = {} as FleetFlowOverviewDto
const page = {} as FleetFlowPage
const request = { id: 'a1', permissionKey: 'fleet.flow.stop' } as ApprovalRequestSummary
function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useFleetFlows', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('list calls the flow page route and optional thread filter', async () => {
    const get = jest.fn(async () => page)
    withApi({ get })
    const { useFleetFlows } = await import(composablePath)
    await useFleetFlows('web').list(2, 't1')
    expect(get).toHaveBeenCalledWith('/projects/web/flows?current=2&size=20&threadId=t1')
    await useFleetFlows('web').list(1)
    expect(get).toHaveBeenLastCalledWith('/projects/web/flows?current=1&size=20')
  })

  test('get and overview call their routes and return API data unchanged', async () => {
    const get = jest.fn(async (path: string) => path.endsWith('/overview') ? overview : flow)
    withApi({ get })
    const { useFleetFlows } = await import(composablePath)
    const api = useFleetFlows('web')
    expect(await api.get('f1')).toBe(flow)
    expect(get).toHaveBeenCalledWith('/projects/web/flows/f1')
    expect(await api.overview('f1')).toBe(overview)
    expect(get).toHaveBeenLastCalledWith('/projects/web/flows/f1/overview')
  })

  test('stop maps saved and pending responses', async () => {
    const post = jest.fn(async () => flow)
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    const api = useFleetFlows('web')
    expect(await api.stop('f1')).toEqual({ kind: 'done', flow })
    expect(post).toHaveBeenCalledWith('/projects/web/flows/f1/stop')
    post.mockImplementation(async () => request)
    expect(await api.stop('f1')).toEqual({ kind: 'pending', request })
  })

  test('createFromThread posts the exact body to the thread route', async () => {
    const post = jest.fn(async () => flow)
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    const body = { features: [{ feature: 'f-min', specPath: '.nax/features/f-min/spec.md', dependsOn: [] }], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 }
    await useFleetFlows('web').createFromThread('t1', body)
    expect(post).toHaveBeenCalledWith('/projects/web/threads/t1/flows', body)
  })

  test('createFromThread maps a flow answer to done', async () => {
    const post = jest.fn(async () => flow)
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    expect(await useFleetFlows('web').createFromThread('t1', { features: [], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 })).toEqual({ kind: 'done', flow })
  })

  test('createFromThread maps an approval answer to pending', async () => {
    const post = jest.fn(async () => request)
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    expect(await useFleetFlows('web').createFromThread('t1', { features: [], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 })).toEqual({ kind: 'pending', request })
  })

  test('createFromThread preserves the API error object', async () => {
    const error = new Error('create failed')
    const post = jest.fn(async () => { throw error })
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    await expect(useFleetFlows('web').createFromThread('t1', { features: [], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 })).rejects.toBe(error)
  })

  test('createFromThread encodes thread ids as one path segment', async () => {
    const post = jest.fn(async () => flow)
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    await useFleetFlows('web').createFromThread('a/b', { features: [], roles: { reviewer: 'm', supervisor: 'm' }, costCapUsd: 2 })
    expect(post).toHaveBeenCalledWith('/projects/web/threads/a%2Fb/flows', expect.anything())
  })

  test('answer posts exactly the answer body and maps pending response', async () => {
    const post = jest.fn(async () => request)
    withApi({ post })
    const { useFleetFlows } = await import(composablePath)
    const answer = [{ id: 'q1', answer: 'yes' }]
    expect(await useFleetFlows('web').answer('f1', 'j9', answer)).toEqual({ kind: 'pending', request })
    expect(post).toHaveBeenCalledWith('/projects/web/flows/f1/answers', { jobId: 'j9', answers: answer })
  })

  test('all API errors reject with the identical error object', async () => {
    const error = new Error('failure')
    const get = jest.fn(async () => { throw error })
    const post = jest.fn(async () => { throw error })
    withApi({ get, post })
    const { useFleetFlows } = await import(composablePath)
    const api = useFleetFlows('web')
    for (const call of [() => api.list(1), () => api.get('f1'), () => api.overview('f1'), () => api.stop('f1'), () => api.answer('f1', 'j9', [])]) {
      await expect(call()).rejects.toBe(error)
    }
  })
})
