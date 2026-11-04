import { afterEach, expect, jest, test } from '@jest/globals'
import { join } from 'path'
import { ref } from 'vue'
import { useApi } from '../../composables/useApi'

const g = globalThis as Record<string, unknown>
afterEach(() => {
  for (const key of ['useApi', 'useRuntimeConfig', 'useI18n', '$fetch']) delete g[key]
})

test('AC-1: list uses useApi GET and returns its unwrapped list, encoding path segments', async () => {
  const rows = [{ id: 'r1', itemId: 'D-1' }]
  const get = jest.fn(async () => rows)
  g.useApi = () => ({ $api: { get } })
  const { useFleetRulings } = await import(join(__dirname, '../../composables/useFleetRulings.ts'))
  expect(await useFleetRulings('my project').list('job/1')).toBe(rows)
  expect(get).toHaveBeenCalledWith('/projects/my%20project/fleet/jobs/job%2F1/rulings')
})

test('AC-2: create posts the unchanged body through useApi and returns the result', async () => {
  const result = { id: 'r1' }
  const post = jest.fn(async () => result)
  g.useApi = () => ({ $api: { post } })
  const { useFleetRulings } = await import(join(__dirname, '../../composables/useFleetRulings.ts'))
  const body = { itemId: 'D-1', text: 'confirm: ok' }
  expect(await useFleetRulings('koda').create('j1', body)).toBe(result)
  expect(post).toHaveBeenCalledWith('/projects/koda/fleet/jobs/j1/rulings', body)
})

test('AC-1/AC-9: real useApi unwraps list and successful 202 approval envelope', async () => {
  const rows = [{ id: 'r1', itemId: 'D-1' }]
  const summary = { id: 'a1', permissionKey: 'fleet.job.rule', status: 'pending' }
  // ofetch returns the response body for all 2xx statuses, not the status or Response.
  const fetch = jest.fn(async (_url: string, options?: Record<string, unknown>) =>
    ({ ret: 0, data: options?.method === 'POST' ? summary : rows }))
  g.useRuntimeConfig = () => ({ apiInternalUrl: 'http://api.test', public: { apiBaseUrl: '/api' } })
  g.useI18n = () => ({ locale: ref('en') })
  g.$fetch = fetch
  g.useApi = useApi
  const { useFleetRulings } = await import(join(__dirname, '../../composables/useFleetRulings.ts'))
  const api = useFleetRulings('koda')
  expect(await api.list('j1')).toBe(rows)
  expect(await api.create('j1', { itemId: 'D-1', text: 'confirm: ok' })).toBe(summary)
  expect(fetch.mock.calls[1]).toEqual(['/api/projects/koda/fleet/jobs/j1/rulings', {
    method: 'POST', body: { itemId: 'D-1', text: 'confirm: ok' }, headers: { 'Accept-Language': 'en', lang: 'en' },
  }])
})
